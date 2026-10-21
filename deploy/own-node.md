# Running your own node proxy for the recovery page

The page asks a Monero node for a small set of calls. A browser can use a node only when the node
answers over HTTPS and allows the page's origin in CORS. A stock `monerod` does neither, so an operator
puts a proxy in front of it. This file shows how.

You need:

- a node on the same host, listening on `127.0.0.1:18081` (the default `monerod` RPC port);
- a DNS name such as `xmr.example.com` and a TLS certificate for it;
- nginx on that host, or any proxy that can send the headers below.

The page itself may live anywhere. Only this name goes into the page's "Your own node" field.

## What the proxy forwards

Forward these paths and nothing else:

| Path | Used for |
| --- | --- |
| `/json_rpc` | chain height, node info, fee estimate |
| `/get_blocks_by_height.bin` | block bodies during the wallet scan |
| `/get_transactions` | transaction lookup |
| `/send_raw_transaction` | broadcast of the signed transaction |
| `/is_key_image_spent` | double spend check before the send |
| `/get_height` | height fallback |

Do not forward the whole RPC surface. The page never calls mining, peer or admin methods, and a proxy
that passes `/stop_daemon` is a proxy that lets anyone stop the node.

## Headers the page needs

Every answer, including errors, must carry:

```
Access-Control-Allow-Origin: *
Access-Control-Allow-Methods: POST, GET, OPTIONS
Access-Control-Allow-Headers: content-type
Cross-Origin-Resource-Policy: cross-origin
```

The origin is `*` because the page holds no cookies and the node returns public chain data. If you
want to name one origin instead, echo the request origin and add `Vary: Origin`.

The preflight must answer `204` for `OPTIONS`. Without it the browser stops before the first JSON call.

`Cross-Origin-Resource-Policy: cross-origin` lets the answers through for a page served with
`Cross-Origin-Embedder-Policy: require-corp`. This page no longer is, so the header is harmless and
only matters to a copy that still sets COEP.

A public node may send its own CORS headers. Hide them in the proxy before adding yours, otherwise the
browser sees two `Access-Control-Allow-Origin` values and refuses the answer.

## Own node, no fallback

Put this in the server block for `xmr.example.com`, after the TLS settings:

```nginx
client_max_body_size 8m;

location ~ ^/(json_rpc|get_blocks_by_height\.bin|get_transactions|send_raw_transaction|is_key_image_spent|get_height)$ {
    proxy_pass http://127.0.0.1:18081;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;

    # The node may already send CORS headers; keep only the ones added here.
    proxy_hide_header Access-Control-Allow-Origin;
    proxy_hide_header Access-Control-Allow-Methods;
    proxy_hide_header Access-Control-Allow-Headers;

    add_header Access-Control-Allow-Origin  "*" always;
    add_header Access-Control-Allow-Methods "POST, GET, OPTIONS" always;
    add_header Access-Control-Allow-Headers "content-type" always;
    add_header Cross-Origin-Resource-Policy "cross-origin" always;

    # A scan asks for many blocks per call; the answer is one large binary body.
    proxy_buffering off;
    proxy_read_timeout 120s;

    if ($request_method = OPTIONS) {
        return 204;
    }
}
```

`deploy/xmr-proxy.conf` is the same block as an include file. Use either one, not both.

## Own node with a public fallback

If your node is down, the page can keep working against a public node. Send the same request to the
fallback only when your node cannot be reached or does not answer in time.

```nginx
client_max_body_size 8m;

location ~ ^/(json_rpc|get_blocks_by_height\.bin|get_transactions|send_raw_transaction|is_key_image_spent|get_height)$ {
    proxy_pass http://127.0.0.1:18081;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_connect_timeout 5s;
    proxy_read_timeout 20s;
    proxy_buffering off;

    proxy_hide_header Access-Control-Allow-Origin;
    proxy_hide_header Access-Control-Allow-Methods;
    proxy_hide_header Access-Control-Allow-Headers;
    add_header Access-Control-Allow-Origin  "*" always;
    add_header Access-Control-Allow-Methods "POST, GET, OPTIONS" always;
    add_header Access-Control-Allow-Headers "content-type" always;
    add_header Cross-Origin-Resource-Policy "cross-origin" always;

    if ($request_method = OPTIONS) {
        return 204;
    }

    error_page 502 504 = @public_node;
}

location @public_node {
    proxy_pass https://xmr-node.cakewallet.com:18081;
    proxy_ssl_server_name on;
    proxy_set_header Host xmr-node.cakewallet.com;
    proxy_http_version 1.1;
    proxy_connect_timeout 5s;
    proxy_read_timeout 120s;
    proxy_buffering off;

    proxy_hide_header Access-Control-Allow-Origin;
    proxy_hide_header Access-Control-Allow-Methods;
    proxy_hide_header Access-Control-Allow-Headers;
    add_header Access-Control-Allow-Origin  "*" always;
    add_header Access-Control-Allow-Methods "POST, GET, OPTIONS" always;
    add_header Access-Control-Allow-Headers "content-type" always;
    add_header Cross-Origin-Resource-Policy "cross-origin" always;
}
```

Notes that matter in practice:

- The fallback sees every request that reaches it, including the address of the visitor if you keep
  the default headers. This is why it is a fallback and not the main path.
- `error_page` catches a dead or timed out node. It does not catch a node that answers `500`, so keep
  the node healthy and watch its logs.
- A shorter `proxy_read_timeout` for your own node makes the fallback start sooner. Do not set it
  below the time a block range needs on a cold node.
- If the page and this proxy share one server block, remember that `add_header` in a location replaces
  the headers set at server level. Repeat anything the page needs in both places.

## Check it before you put it in the field

```sh
# preflight: expect 204 and the three Access-Control headers
curl -sS -i -X OPTIONS https://xmr.example.com/json_rpc \
  -H 'Origin: https://recovery.ninsei.finance' \
  -H 'Access-Control-Request-Method: POST' \
  -H 'Access-Control-Request-Headers: content-type'

# a real call: expect "status": "OK" and "nettype": "mainnet"
curl -sS https://xmr.example.com/json_rpc \
  -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":"0","method":"get_info"}'

# the binary path must exist: 400 means the node answered, 404 means the proxy does not pass it
curl -sS -o /dev/null -w '%{http_code}\n' -X POST \
  https://xmr.example.com/get_blocks_by_height.bin \
  -H 'content-type: application/octet-stream' --data-binary ''
```

Then open the page and enter `https://xmr.example.com` under "Your own node", or open it with
`?node=https://xmr.example.com`. The row turns green when the node answers on mainnet, synchronized and
close to the listed nodes' height. A page served over HTTPS cannot use an `http://` node: the browser
blocks that call as mixed content.

## Keep the node private

- `monerod` stays on `127.0.0.1` or a private interface. Only the proxy listens on 443.
- Do not enable restricted RPC with credentials for this proxy. The page sends no credentials and the
  data is public.
- Rate limit the name if it is open to the internet. A scan is a handful of large requests, not a
  stream, so a simple per address limit is enough.
- Keep `client_max_body_size` at a few megabytes. A signed transaction is small, and a large limit only
  helps someone send you garbage.

import base64
import json
import sys

LOG_PATH = "/tmp/mcpdet-flows.jsonl"
BODY_LIMIT = 10 * 1024 * 1024
SEEN = set()


def load(_loader):
    try:
        with open(LOG_PATH, "a", encoding="utf-8"):
            pass
    except OSError:
        sys.exit(1)


def response(flow):
    write_flow(flow)


def error(flow):
    if flow.response is not None:
        return
    write_flow(flow)


def write_flow(flow):
    flow_id = str(flow.id)
    if flow_id in SEEN or flow.request is None:
        return
    peer = flow.client_conn.peername
    if peer is None or len(peer) < 2:
        return
    address = str(peer[0])
    if address.lower().startswith("::ffff:"):
        address = address[7:]
    start = flow.request.timestamp_start
    if start is None:
        return
    end = flow_end(flow, start)
    record = {
        "flow_id": flow_id,
        "client": {"address": address, "port": int(peer[1])},
        "start_us": round(start * 1_000_000),
        "duration_us": max(0, round((end - start) * 1_000_000)),
        "request": {
            "method": str(flow.request.method),
            "url": str(flow.request.pretty_url),
            "host": str(flow.request.host),
            "headers": header_pairs(flow.request.headers),
            "body": body_of(flow.request.content),
        },
        "result": result_of(flow),
    }
    SEEN.add(flow_id)
    with open(LOG_PATH, "a", encoding="utf-8") as handle:
        handle.write(json.dumps(record) + "\n")
        handle.flush()


def flow_end(flow, start):
    response_message = flow.response
    if response_message is not None and response_message.timestamp_end is not None:
        return response_message.timestamp_end
    if response_message is not None and response_message.timestamp_start is not None:
        return response_message.timestamp_start
    return start


def header_pairs(headers):
    pairs = []
    for key, value in headers.items(multi=True):
        pairs.append([str(key), str(value)])
    return pairs


def body_of(content):
    raw = b"" if content is None else content
    truncated = len(raw) > BODY_LIMIT
    data = raw[:BODY_LIMIT]
    try:
        text = data.decode("utf-8")
    except UnicodeDecodeError:
        return {
            "kind": "base64",
            "base64": base64.b64encode(data).decode("ascii"),
            "byte_count": len(raw),
            "truncated": truncated,
        }
    return {"kind": "text", "text": text, "byte_count": len(raw), "truncated": truncated}


def result_of(flow):
    response_message = flow.response
    if response_message is None:
        message = "proxy error" if flow.error is None else str(flow.error.msg)
        return {"kind": "error", "message": message}
    return {
        "kind": "response",
        "response": {
            "status": int(response_message.status_code),
            "headers": header_pairs(response_message.headers),
            "body": body_of(response_message.content),
        },
    }

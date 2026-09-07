import time
import json
import subprocess
from http.server import HTTPServer, BaseHTTPRequestHandler
import threading

polled = False
received_result = None

class BridgeHandler(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def do_GET(self):
        global polled
        if self.path == "/poll":
            polled = True
            cmd = json.dumps({"id": "test-1", "action": "GET_LIVE_STATUS"}).encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(cmd)))
            self.end_headers()
            self.wfile.write(cmd)
        else:
            self.send_response(404)
            self.end_headers()

    def do_POST(self):
        global received_result
        if self.path == "/respond":
            length = int(self.headers.get("Content-Length", 0))
            data = json.loads(self.rfile.read(length).decode("utf-8"))
            received_result = data
            self.send_response(200)
            self.end_headers()
            self.wfile.write(b'{"status":"ok"}')

def main():
    adb = r"C:\Users\rkadh\AppData\Local\Android\Sdk\platform-tools\adb.exe"
    subprocess.run([adb, "-s", "d988dd17", "reverse", "tcp:8088", "tcp:8088"], capture_output=True)

    HTTPServer.allow_reuse_address = True
    server = HTTPServer(("127.0.0.1", 8088), BridgeHandler)
    t = threading.Thread(target=server.serve_forever, daemon=True)
    t.start()
    print("Bridge server listening on port 8088...")

    for _ in range(40):
        if received_result:
            break
        time.sleep(0.25)

    server.shutdown()

    if received_result:
        print("BRIDGE TEST SUCCESS!")
        print(json.dumps(received_result, indent=2))
    else:
        print(f"FAILED: polled={polled}, received_result={received_result}")

if __name__ == "__main__":
    main()
import subprocess, os, sys, time, re, json

RPC = os.environ["YOMINET_RPC"]
CAST = os.path.expanduser("~/.foundry/bin/cast")
MOVE = "0x7af6e640d4994b7164e880e065dee53320f8d021"
ROOMCOMP = "0x07511f484f18e363da04b64da5fd976dc488ec3d"

def cast(*args):
    r = subprocess.run([CAST, *args], capture_output=True, text=True)
    return r.returncode, r.stdout.strip(), r.stderr.strip()

def room_of(acc):
    _, out, _ = cast("call", ROOMCOMP, "get(uint256)(uint32)", acc, "--rpc-url", RPC)
    return int(re.match(r"(\d+)", out).group(1)) if out else -1

pods = json.load(open(os.path.expanduser("~/kamigotchi/tools/vault-kit/pods.json")))
jobs = [
    ("HUB", "1425804748651105212219984478994559116987885527392",
     os.environ["OPERATOR_PRIVATE_KEY"], [29, 2, 3, 30, 4, 34, 12]),
    ("POD2", "421884181389582686297877971087608488169143461324",
     next(p["operatorKey"] for p in pods["pods"] if p["node"] == 2), [29, 2]),
    ("POD3", "1280716820635770175565603046638036134479179052285",
     next(p["operatorKey"] for p in pods["pods"] if p["node"] == 3), [29, 2, 3]),
]

for name, acc, key, path in jobs:
    cur = room_of(acc)
    print(f"{name}: room {cur}, target {path[-1]}")
    if cur == path[-1]:
        print(f"  already there"); continue
    hops = path[path.index(cur) + 1:] if cur in path else path
    for hop in hops:
        for attempt in range(4):
            rc, out, err = cast("send", MOVE, "executeTyped(uint32)", str(hop),
                                "--rpc-url", RPC, "--private-key", key, "--legacy")
            if rc == 0 and "status               1" in out:
                print(f"  -> room {hop} ok"); break
            msg = (err or out)[-160:]
            print(f"  -> room {hop} attempt {attempt+1} failed: {msg}")
            if "stamina" in msg.lower():
                time.sleep(60)
            else:
                time.sleep(8)
        else:
            print(f"  {name} STUCK before room {hop} (current: {room_of(acc)})"); break
        time.sleep(3)
    print(f"  {name} final room: {room_of(acc)}")

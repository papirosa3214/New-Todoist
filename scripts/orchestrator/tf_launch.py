# usage: tf_launch.py spec.json   (env O=orchestrator token; единственный ключ, с 05.10.2026)
import os,json,sys,urllib.request,urllib.error
B="http://localhost:3001"
def req(tok,m,p,body=None):
    h={"Authorization":"Bearer "+tok}
    if body is not None: h["Content-Type"]="application/json"
    r=urllib.request.Request(B+p,method=m,headers=h,data=json.dumps(body).encode() if body is not None else None)
    try: return json.load(urllib.request.urlopen(r))
    except urllib.error.HTTPError as e: return {"error":e.code,"body":e.read().decode()[:300]}
spec=json.load(open(sys.argv[1]))
t=req(os.environ["O"],"POST","/api/tasks",{"title":spec["title"],"description":spec["description"],"project_id":"c2fcbcdb-951f-449f-a1bd-123ea2a46a58","priority":spec.get("priority",2)})
t=t.get("task",t); tid=t.get("id")
if not tid: print("CREATE FAIL",t); sys.exit(1)
roles=spec["roles"]; nodes=[]; edges=[]
for i,(slot,role,res) in enumerate(roles):
    nodes.append({"slot_key":slot,"role_key":role,"required":True,"expected_result":res})
    if i: edges.append({"from_slot_key":roles[i-1][0],"to_slot_key":slot})
p=req(os.environ["O"],"POST",f"/api/tasks/{tid}/collaboration-plans",{"profile":"delivery","rationale":spec.get("rationale","План оркестратора"),"nodes":nodes,"edges":edges})
p=p.get("plan",p)
if not p.get("id"): print("PLAN FAIL",tid,p); sys.exit(1)
a=req(os.environ["O"],"POST",f"/api/tasks/{tid}/collaboration-plans/{p['id']}/approve",{})
a=a.get("plan",a)
print("OK",tid,a.get("status"),a.get("error"),a.get("body"),[n["role_key"] for n in a.get("nodes",[])])

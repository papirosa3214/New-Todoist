# usage: tf_plan_existing.py TASK_ID roles_json   (O=orchestrator token)
import os,json,sys,urllib.request,urllib.error
B="http://localhost:3001"; O=os.environ["O"]
def req(m,p,body=None):
    h={"Authorization":"Bearer "+O}
    if body is not None: h["Content-Type"]="application/json"
    r=urllib.request.Request(B+p,method=m,headers=h,data=json.dumps(body).encode() if body is not None else None)
    try: return json.load(urllib.request.urlopen(r))
    except urllib.error.HTTPError as e: return {"error":e.code,"body":e.read().decode()[:300]}
tid=sys.argv[1]; roles=json.loads(sys.argv[2]); nodes=[]; edges=[]
for i,(slot,role,res) in enumerate(roles):
    nodes.append({"slot_key":slot,"role_key":role,"required":True,"expected_result":res})
    if i: edges.append({"from_slot_key":roles[i-1][0],"to_slot_key":slot})
p=req("POST",f"/api/tasks/{tid}/collaboration-plans",{"profile":"delivery","rationale":"План оркестратора","nodes":nodes,"edges":edges}); p=p.get("plan",p)
if not p.get("id"): print("PLAN FAIL",tid[:8],p); sys.exit(1)
a=req("POST",f"/api/tasks/{tid}/collaboration-plans/{p['id']}/approve",{}); a=a.get("plan",a)
print("OK",tid[:8],a.get("status"),a.get("error"),a.get("body"))

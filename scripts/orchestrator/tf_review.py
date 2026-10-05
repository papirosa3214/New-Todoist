# usage: tf_review.py TASK_ID "что проверять"   (O=orchestrator token) — ставит план QA -> Критик на уже сделанную задачу
import os,json,sys,urllib.request,urllib.error
B="http://localhost:3001"; O=os.environ["O"]
def req(m,p,body=None):
    h={"Authorization":"Bearer "+O}
    if body is not None: h["Content-Type"]="application/json"
    r=urllib.request.Request(B+p,method=m,headers=h,data=json.dumps(body).encode() if body is not None else None)
    try: return json.load(urllib.request.urlopen(r))
    except urllib.error.HTTPError as e: return {"error":e.code,"body":e.read().decode()[:300]}
tid,what=sys.argv[1],sys.argv[2]
nodes=[{"slot_key":"qa","role_key":"qa","required":True,"expected_result":"Проверка сделанного: "+what},
       {"slot_key":"critic","role_key":"critic_verifier","required":True,"expected_result":"Независимая проверка результата"}]
p=req("POST",f"/api/tasks/{tid}/collaboration-plans",{"profile":"delivery","rationale":"Работа сделана одной ролью без проверки — оркестратор ставит QA и Критика до вливания в main.","nodes":nodes,"edges":[{"from_slot_key":"qa","to_slot_key":"critic"}]})
p=p.get("plan",p)
if not p.get("id"): print("PLAN FAIL",p); sys.exit(1)
a=req("POST",f"/api/tasks/{tid}/collaboration-plans/{p['id']}/approve",{}); a=a.get("plan",a)
print("OK",tid[:8],a.get("status"),a.get("error"),a.get("body"))

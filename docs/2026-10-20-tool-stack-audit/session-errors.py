import glob,json,os,collections,datetime
cutoff='2026-10-19T00:00:00'
counts=collections.Counter();calls={};seen=set();role_counts=collections.Counter();false_ok=[];samples={}
files=glob.glob('/home/maksim/taskflow/roles/*/sessions/**/*.jsonl',recursive=True)+glob.glob('/home/maksim/.local/state/taskflow-runs/sessions/**/*.jsonl',recursive=True)
files=[f for f in files if os.path.getmtime(f)>datetime.datetime.fromisoformat('2026-10-19').timestamp()]
for f in files:
 role=f.split('/roles/')[1].split('/')[0] if '/roles/' in f else next((r for r in ['critic_verifier','code_orchestrator','infra_engineer','researcher','architect','designer','secretary','analyst','builder','qa'] if '-'+r+'-' in f),'work')
 for line in open(f):
  try:x=json.loads(line)
  except:continue
  if x.get('timestamp','')<cutoff:continue
  m=x.get('message',{})
  if m.get('role')=='assistant':
   for b in m.get('content',[]):
    if b.get('type')=='toolCall':calls[(role,b.get('id'))]=b
  if m.get('role')!='toolResult':continue
  key=(role,m.get('toolCallId'))
  if key in seen:continue
  seen.add(key)
  call=calls.get(key,{})
  args=call.get('arguments',{})
  op=args.get('operation') if m.get('toolName')=='taskflow' else m.get('toolName')
  for b in m.get('content',[]):
   if b.get('type')!='text':continue
   try:d=json.loads(b.get('text',''))
   except:continue
   if not isinstance(d,dict):continue
   if d.get('ok') is False:
    code=d.get('error',{}).get('code','unknown')
    counts[(op or 'unknown',code)]+=1;role_counts[(role,code)]+=1
    samples.setdefault((op,code),{'role':role,'timestamp':x.get('timestamp'),'message':d.get('error',{}).get('message','')[:700]})
   elif d.get('ok') is True:
    for inner in d.get('data',{}).get('content',[]):
     try:nested=json.loads(inner.get('text',''))
     except:continue
     if isinstance(nested,dict) and (nested.get('ошибка') or nested.get('error') or nested.get('ok') is False):
      false_ok.append({'role':role,'operation':op,'timestamp':x.get('timestamp'),'keys':list(nested),'error':str(nested.get('ошибка',nested.get('error')))[:350]})
result={'cutoff':cutoff,'files':len(files),'uniqueToolResults':len(seen),'errors':[{'operation':op,'code':code,'count':n,'sample':samples.get((op,code))} for (op,code),n in counts.most_common()],'roleErrors':[{'role':role,'code':code,'count':n} for (role,code),n in role_counts.most_common()],'falseSuccess':false_ok}
open('docs/2026-10-20-tool-stack-audit/session-errors.json','w').write(json.dumps(result,ensure_ascii=False,indent=2))
print('FILES',len(files),'RESULTS',len(seen),'ERRORS',sum(counts.values()),'FALSE_OK',len(false_ok))
for (op,code),n in counts.most_common(14):print(n,op,code)
for r in false_ok[:6]:print('FALSE_OK',r['operation'],r['error'])

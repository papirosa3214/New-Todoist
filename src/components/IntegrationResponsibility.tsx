import {useState} from 'react';
import {useQuery,useQueryClient} from '@tanstack/react-query';
import {api} from '../api/client';
type Responsibility={mode:string;owner_id:string|null;owner_title:string|null;valid:boolean;candidates:{id:string;title:string}[]};
export function IntegrationResponsibility({taskId}:{taskId:string}) {
 const queryClient=useQueryClient();const [help,setHelp]=useState(false);const [error,setError]=useState<string|null>(null);const [saving,setSaving]=useState(false);
 const key=['integration-responsibility',taskId];
 const {data,isError}=useQuery({queryKey:key,queryFn:()=>api.get<Responsibility>(`/api/tasks/${taskId}/integration-responsibility`),refetchInterval:5000});
 async function select(value:string){setSaving(true);try{const mode=value==='auto'||value==='not_required'?value:'manual';const owner_id=mode==='manual'?(value||null):null;const next=await api.patch<Responsibility>(`/api/tasks/${taskId}/integration-responsibility`,{mode,owner_id});queryClient.setQueryData(key,next);setError(null);}catch(e){setError(e instanceof Error?e.message:'Не удалось сохранить назначение');}finally{setSaving(false);}}
 return <section className="px-4 py-3" aria-label="Ответственный за интеграцию">
 <div className="flex items-center gap-2"><span>Ответственный за интеграцию</span><button type="button" className="text-dim" aria-label="Об ответственности за интеграцию" aria-expanded={help} onClick={()=>setHelp(!help)}>?</button></div>
 {data&&<select aria-label="Ответственный за интеграцию" className="bg-card text-text mt-2" disabled={saving} value={data.mode==='manual'?data.owner_id??'':data.mode} onChange={e=>void select(e.target.value)}>
 <option value="auto">Автоматически{data.mode==='auto'&&data.owner_title?' — '+data.owner_title:''}</option><option value="">Не выбран</option>{data.candidates.map(c=><option key={c.id} value={c.id}>{c.title}</option>)}<option value="not_required">Не требуется</option></select>}
 {data&&!data.valid&&<p className="text-red mt-2">Назначьте ответственного за перенос изменений в основную ветку</p>}
 {(error||isError)&&<p className="text-red">{error??'Не удалось загрузить назначение'}</p>}
 {help&&<div role="note" className="tf-meta text-sub mt-3"><p>Переносит проверенные изменения из рабочих веток в основную ветку и проверяет общий результат.</p><p>Оркестратор → архитектор → единственный исполнитель. Если исполнителей несколько, выберите участника. Назначение можно изменить.</p><p>Для работы без изменений репозитория — «Не требуется». Черновик сохранить можно; запуск требует назначения. Выкладка выполняется отдельно, если входит в задачу.</p></div>}
 </section>;
}

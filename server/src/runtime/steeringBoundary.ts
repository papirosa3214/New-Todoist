import {STEERING_REFUSAL} from "./serverRefusal.js";
/** SDK drains steering after a tool batch. Defer not-yet-started calls so
 * the next model request can reconsider them with the new user message.
 * Every original toolCall still receives a result; no transcript holes.
 * External CLI sessions expose no Agent hooks and are intentionally untouched.
 */
export function installSteeringBoundary(session: any): void {
 const agent=session.agent;
 if(!agent || typeof session.getSteeringMessages!=="function")return;
 if(installed.has(agent))return;
 installed.add(agent);
 const before=agent.beforeToolCall;
 agent.toolExecution="sequential";
 agent.beforeToolCall=async (...args:any[])=>{
  if(session.getSteeringMessages().length)return {block:true,reason:STEERING_REFUSAL};
  const result=await before?.apply(agent,args);
  // A message may arrive while an existing async access/extension hook runs.
  if(!result?.block && session.getSteeringMessages().length)return {block:true,reason:STEERING_REFUSAL};
  return result;
 };
}
const installed=new WeakSet<object>();

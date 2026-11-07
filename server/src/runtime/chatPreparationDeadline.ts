/** Preparation has no running model or tool to abort. Bound every await and
 * dispose resources that arrive after the deadline, before they can execute. */
export class ChatPreparationDeadline {
  private expired = false;
  private transferred = false;
  private cleanups: Array<()=>unknown> = [];
  private timer: ReturnType<typeof setTimeout>;
  private failure: Error;
  private deadline: Promise<never>;

  constructor() {
    const raw = Number(process.env.TASKFLOW_CHAT_PREPARATION_TIMEOUT_MS ?? 300_000);
    const limitMs = Number.isFinite(raw) && raw > 0 ? raw : 300_000;
    this.failure = Object.assign(new Error("Истёк срок подготовки сессии чата"), {code:"CHAT_RUN_PREPARATION_TIMEOUT",limitMs});
    let reject!: (error:Error)=>void;
    this.deadline = new Promise<never>((_,r)=>{reject=r;});
    this.deadline.catch(()=>{});
    this.timer = setTimeout(()=>{this.expired=true;reject(this.failure);},limitMs);
    this.timer.unref?.();
  }

  async wait<T>(value:PromiseLike<T>|T, cleanup?:(resource:T)=>unknown):Promise<T> {
    const resource = Promise.resolve(value).then(result=>{
      if (this.expired) {
        if (cleanup) this.clean(()=>cleanup(result));
        throw this.failure;
      }
      if (cleanup) this.cleanups.push(()=>cleanup(result));
      return result;
    });
    return Promise.race([resource,this.deadline]);
  }

  /** The existing runtime now owns the resources and its execution ceiling. */
  transfer():void {
    clearTimeout(this.timer);
    this.transferred=true;
    this.cleanups=[];
  }

  dispose():void {
    clearTimeout(this.timer);
    if (this.transferred) return;
    this.expired=true;
    for (const cleanup of this.cleanups.splice(0).reverse()) this.clean(cleanup);
  }
  private clean(cleanup:()=>unknown):void {
    try { void Promise.resolve(cleanup()).catch(()=>{}); } catch { /* Already closed. */ }
  }
}

export async function prepareChatValue<T>(value:PromiseLike<T>|T):Promise<T> {
  const preparation = new ChatPreparationDeadline();
  try { return await preparation.wait(value); }
  finally { preparation.dispose(); }
}

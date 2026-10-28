import {randomUUID} from "node:crypto";
import {AsyncLocalStorage} from "node:async_hooks";
import {channel} from "node:diagnostics_channel";

type NativeScope = {enabled:boolean; begin:(request:any)=>void; error:(request:any,error:unknown)=>void; headers:(request:any,status:number,headers?:any)=>void};
const nativeScope = new AsyncLocalStorage<NativeScope>();
const nativeRequests = new WeakMap<object, NativeScope>();
// Google adapters reject custom fetch. Observe Node's transport without replacing it.
// Restrict attribution to requests created inside a model invocation.
for (const prefix of ["undici","http.client"]) {
  const create = prefix==="undici" ? "undici:request:create" : "http.client.request.start";
  const failure = prefix==="undici" ? "undici:request:error" : "http.client.request.error";
  channel(create).subscribe((message:any)=>{
    try {
      const scope=nativeScope.getStore();
      if(scope?.enabled && message.request) {nativeRequests.set(message.request,scope);scope.begin(message.request);}
    } catch {}
  });
  channel(failure).subscribe((message:any)=>{
    try {nativeRequests.get(message.request)?.error(message.request,message.error);} catch {}
  });
}
channel("undici:request:headers").subscribe((message:any)=>{
  try {nativeRequests.get(message.request)?.headers(message.request,message.response?.statusCode,message.response?.headers);} catch {}
});


type Entry = Record<string, unknown>;
type Runtime = Record<string, any>;
type Options = {emit?: (entry: Entry) => void; fetch?: typeof fetch};
const installed = new WeakSet<object>();
const observedSessions = new WeakSet<object>();
const sessions = new Map<string, Record<string, string | undefined>>();
/** Bounded metadata only; no session messages are retained. */
export function registerProviderSession(sessionId: string, context: Record<string, string | undefined>): void {
  if (!sessionId) return;
  sessions.delete(sessionId);
  sessions.set(sessionId, context);
  if (sessions.size > 4096) sessions.delete(sessions.keys().next().value!);
}

/** Session retry events complement per-network-attempt records. */
export function observeProviderRetries(session: any, sessionId: string): void {
  if (!session?.subscribe || observedSessions.has(session)) return;
  observedSessions.add(session);
  session.subscribe((e:any) => {
    if (!["auto_retry_start","auto_retry_end","summarization_retry_scheduled","summarization_retry_attempt_start","summarization_retry_finished"].includes(e.type)) return;
    try {
      console.error("[provider-diagnostics]", JSON.stringify({
        schema_version:1, timestamp:new Date().toISOString(), event:e.type, session_id:sessionId, ...sessions.get(sessionId),
        attempt:e.attempt, max_attempts:e.maxAttempts, delay_ms:e.delayMs, success:e.success,
        error:sanitize(e.errorMessage ?? e.finalError,new Set()),
        provider:session.model?.provider, model:session.model?.id,
      }));
    } catch {}
  });
}

/** Observe the shared Pi boundary, before its SDK flattens transport errors.
 * No request/response content, credentials or arbitrary headers are logged. */
export function installProviderDiagnostics(runtime: Runtime, dependencies: Options = {}): void {
  if (installed.has(runtime)) return;
  installed.add(runtime);
  const emit = (entry: Entry) => {
    try {
      (dependencies.emit ?? ((value) => console.error("[provider-diagnostics]", JSON.stringify(value))))({
        schema_version:1, timestamp: new Date().toISOString(), ...entry,
      });
    } catch { /* Observability must never fail a model request. */ }
  };
  emit({event:"diagnostics_enabled",schema_version:1});
  for (const method of ["stream", "streamSimple"] as const) {
    if (typeof runtime[method] !== "function") continue;
    const original = runtime[method].bind(runtime);
    runtime[method] = (model: any, context: any, options: any = {}) => {
      const callId = randomUUID();
      const started = Date.now();
      let attempt = 0;
      let lastStatus: number | undefined;
      const secrets = new Set<string>();
      if (typeof options.apiKey === "string") secrets.add(options.apiKey);
      const clean = (value: unknown) => sanitize(value, secrets);
      const base = {
        call_id: callId, provider: clean(model?.provider), model: clean(model?.id), api: clean(model?.api),
        session_id: clean(options.sessionId), endpoint: safeUrl(model?.baseUrl),
        timeout_ms: options.timeoutMs ?? null, configured_transport_retries: options.maxRetries ?? null,
        message_count: Array.isArray(context?.messages) ? context.messages.length : 0,
        transport: options.transport ?? "provider_default", websocket_connect_timeout_ms: options.websocketConnectTimeoutMs ?? null,
        tool_count: Array.isArray(context?.tools) ? context.tools.length : 0,
      };
      const log = (event: string, data: Entry = {}) => emit({...base, origin:"runtime", ...sessions.get(options.sessionId), event, elapsed_ms: Date.now()-started, ...data});
      const fetchImpl = options.fetch ?? dependencies.fetch;
      const instrumentedFetch = async (input: any, init?: any): Promise<Response> => {
        const n = ++attempt;
        const id = randomUUID();
        const t = Date.now();
        const request = typeof Request !== "undefined" && input instanceof Request ? input : undefined;
        for (const headers of [request?.headers, init?.headers]) {
          if (!headers) continue;
          try {
            new Headers(headers).forEach((v,k) => {
              if (/authorization|api.?key|cookie|token|secret/i.test(k)) {
                secrets.add(v);
                if (/^Bearer /i.test(v)) secrets.add(v.slice(7));
              }
            });
          } catch { /* malformed headers will be reported by the real fetch */ }
        }
        const signal: AbortSignal | undefined = init?.signal ?? request?.signal;
        const transportCategory = (error:unknown) => options.signal?.aborted ? classify(error,undefined,options.signal) :
          signal?.aborted ? (signal.reason?.name==="TimeoutError" ? "deadline" : "request_aborted") : classify(error);
        const abortSource = () => options.signal?.aborted ? "caller" : signal?.aborted ? "request_signal" : undefined;
        const fields = {request_id:id, attempt:n, endpoint:safeUrl(request?.url ?? input), method:init?.method ?? request?.method ?? "GET"};
        const event = (name: string, more: Entry = {}) => log(name, {...fields, attempt_elapsed_ms:Date.now()-t, ...more});
        event("request_start");
        let response: Response;
        try {
          response = await nativeScope.run({...native,enabled:false},()=> (fetchImpl ?? globalThis.fetch)(input, init));
        } catch (error) {
          event("transport_error", {phase:"request",category:transportCategory(error),abort_source:abortSource(),error:serializeError(error,clean),
            signal_aborted:signal?.aborted ?? false, abort_reason:signal?.aborted ? serializeError(signal.reason,clean) : undefined});
          throw error;
        }
        lastStatus=response.status;
        const upstream = response.headers.get("request-id") ?? response.headers.get("x-request-id") ??
          response.headers.get("x-amzn-requestid") ?? response.headers.get("cf-ray");
        const responseInfo = {status:response.status,upstream_request_id:clean(upstream),retry_after:clean(response.headers.get("retry-after")),
          retry_after_ms:clean(response.headers.get("retry-after-ms")), content_type:clean(response.headers.get("content-type"))};
        event(response.ok ? "response_headers" : "http_error", {...responseInfo,phase:"headers",
          category:response.ok ? undefined : classify(undefined,response.status)});
        if (!response.ok) {
          // Only consume a bounded clone. The SDK retains the original error body.
          try { void readErrorEnvelope(response.clone(), clean).then(providerError => {
            if (providerError) event("http_error_detail", {...responseInfo,provider_error:providerError});
          }).catch(()=>{}); } catch {}
        }
        if (!response.body) return response;
        const reader=response.body.getReader();
        let bytes=0;
        let first=true;
        const decoder=new TextDecoder();
        let lineBuffer="";
        const inspectChunk=(chunk:Uint8Array)=>{
          // Inspect protocol metadata only. Never record text/tool arguments.
          lineBuffer+=decoder.decode(chunk,{stream:true});
          const lines=lineBuffer.split("\n"); lineBuffer=lines.pop() ?? "";
          if(lineBuffer.length>65536) lineBuffer="";
          for(const line of lines) {
            if(!line.startsWith("data:") || line.length>65536)continue;
            try {
              const value=JSON.parse(line.slice(5).trim());
              if(value.type==="error" || value.error || value.type==="response.failed") {
                const error=value.error ?? value.response?.error ?? {};
                const detail:Entry={};
                for(const key of ["type","code","message","param"]) if(typeof error[key]==="string")detail[key]=clean(error[key]);
                event("provider_stream_error",{...responseInfo,phase:"response_body",provider_error:detail});
              }
              const reason=value.delta?.stop_reason ?? value.choices?.[0]?.finish_reason ?? value.response?.incomplete_details?.reason;
              if(reason) event("provider_stop",{...responseInfo,stop_reason:clean(reason)});
            } catch { /* partial/non-JSON SSE is left to the provider SDK */ }
          }
        };
        const body=new ReadableStream<Uint8Array>({
          async pull(controller) {
            try {
              const item=await reader.read();
              if (item.done) {
                event("response_end",{...responseInfo,bytes_received:bytes});
                controller.close();
              } else {
                bytes+=item.value.byteLength;
                inspectChunk(item.value);
                if(first){first=false;event("first_byte",responseInfo);}
                controller.enqueue(item.value);
              }
            } catch(error) {
              event("transport_error",{...responseInfo,phase:"response_body",category:transportCategory(error),abort_source:abortSource(),
                bytes_received:bytes,error:serializeError(error,clean),signal_aborted:signal?.aborted ?? false,
                abort_reason:signal?.aborted ? serializeError(signal.reason,clean) : undefined});
              controller.error(error);
            }
          },
          cancel(reason) {
            event("response_cancelled",{...responseInfo,phase:"response_body",bytes_received:bytes,
              signal_aborted:signal?.aborted ?? false,reason:serializeError(reason,clean)});
            return reader.cancel(reason);
          },
        });
        const wrapped=new Response(body,{status:response.status,statusText:response.statusText,headers:response.headers});
        for(const key of ["url","redirected","type"] as const) {
          Object.defineProperty(wrapped,key,{value:response[key]});
        }
        return wrapped;
      };
      const fetchApis = ["anthropic-messages","openai-completions","openai-responses","azure-openai-responses","openai-codex-responses","mistral-conversations","pi-messages","openrouter-images"];
      const canInjectFetch = !model?.api || fetchApis.includes(model.api);
      const nativeAttempts = new WeakMap<object, Entry>();
      const native: NativeScope = {
        enabled: true, // Also observe OAuth refreshes before the provider API fetch.
        begin(request:any) {
          const fields={request_id:randomUUID(),attempt:++attempt,
            endpoint:safeUrl(request.origin ? String(request.origin)+request.path : (request.protocol ?? "https:")+"//"+request.host+request.path),
            method:request.method};
          nativeAttempts.set(request,{...fields,started:Date.now()});
          log("native_request_start",fields);
        },
        error(request:any,error:unknown) {
          const fields=nativeAttempts.get(request);
          log("native_transport_error",{...fields,started:undefined,
            attempt_elapsed_ms:fields ? Date.now()-Number(fields.started) : undefined,
            category:classify(error),error:serializeError(error,clean)});
        },
        headers(request:any,status:number,rawHeaders?:any) {
          lastStatus=status;
          const headers=new Headers();
          try {
            if(Array.isArray(rawHeaders)) for(let i=0;i+1<rawHeaders.length;i+=2) headers.set(String(rawHeaders[i]),String(rawHeaders[i+1]));
          } catch {}

          log(status>=400 ? "native_http_error" : "native_response_headers",
            {...nativeAttempts.get(request),started:undefined,status,upstream_request_id:clean(headers.get("request-id") ?? headers.get("x-request-id")),retry_after:clean(headers.get("retry-after")),category:status>=400 ? classify(undefined,status) : undefined});
        },
      };
      const wrappedOptions={
        ...options, ...(canInjectFetch ? {fetch:instrumentedFetch} : {}),
        onPayload: async (payload:any, selected:any) => {
          // Counts/size help diagnose context rejection without storing conversations.
          try { log("model_request",{payload_bytes:Buffer.byteLength(JSON.stringify(payload)),attempts_so_far:attempt}); } catch {}
          return options.onPayload ? await options.onPayload(payload,selected) : undefined;
        },
        onResponse: async (response:any, selected:any) => {
          log("sdk_response",{status:response.status});
          await options.onResponse?.(response,selected);
        },
      };
      try {
        const stream=nativeScope.run(native,()=>original(model,context,wrappedOptions));
        // result() is a shared promise in Pi; observing it does not drain events.
        void Promise.resolve(stream.result()).then((message:any) => {
          for (const diagnostic of (message?.diagnostics ?? []).slice(0,16)) {
            const details:Entry={};
            for(const key of ["configuredTransport","fallbackTransport","eventsEmitted","phase","requestBytes"]) {
              const value=diagnostic.details?.[key];
              if(["string","number","boolean"].includes(typeof value)) details[key]=typeof value==="string" ? clean(value) : value;
            }
            log("sdk_diagnostic",{diagnostic_type:clean(diagnostic.type),error:serializeError(diagnostic.error,clean),details});
          }
          const reason=message?.stopReason;
          const content=Array.isArray(message?.content) ? message.content : [];
          const hasOutput=content.some((c:any)=>c.type==="toolCall" || (c.type==="text" && c.text?.trim()));
          log("model_result",{
            stop_reason:clean(reason), attempts:attempt,status:lastStatus,
            category:reason==="error" ? classifyModelError(message?.errorMessage) : reason==="aborted" ? "cancelled" :
              reason==="refusal" || reason==="content_filter" ? "model_refusal" :
              reason==="length" ? "output_limit" : !hasOutput ? "empty_answer" : "success",
            error:message?.errorMessage ? clean(message.errorMessage) : undefined,
            upstream_response_id:clean(message?.responseId), input_tokens:message?.usage?.input,output_tokens:message?.usage?.output,
          });
        }, error => log("sdk_error",{attempts:attempt,error:serializeError(error,clean),category:classify(error)}))
        .catch(()=>{});
        return stream;
      } catch(error) {
        log("sdk_error",{attempts:attempt,error:serializeError(error,clean),category:classify(error)});
        throw error;
      }
    };
  }
}

function safeUrl(value: unknown): string | undefined {
  try {const u=new URL(String(value));return u.origin+u.pathname;} catch {return undefined;}
}
function sanitize(value: unknown, secrets: Set<string>): string | undefined {
  if(value === undefined || value === null) return undefined;
  let text=String(value);
  for(const secret of secrets) if(secret.length>=4) text=text.split(secret).join("<REDACTED>");
  return text
    .replace(/https?:\/\/[^\s"'<>]+/g, url=>safeUrl(url) ?? "<URL>")
    .replace(/Bearer\s+[^\s"',;]+/gi,"Bearer <REDACTED>")
    .replace(/\b(?:sk|sk-cp|key)-[a-zA-Z0-9_-]{8,}/g,"<REDACTED>")
    .replace(/((?:api[_-]?key|token|password|secret|authorization)\s*["']?\s*[:=]\s*["']?)[^\s"',;}]+/gi,"$1<REDACTED>")
    .slice(0,2000);
}
function serializeError(error: any, clean: (x:unknown)=>string|undefined, depth=0, seen=new Set<any>()): any {
  if(error === undefined || error === null) return undefined;
  if(typeof error!=="object") return {message:clean(error)};
  if(depth>=5 || seen.has(error)) return {message:"<cause limit>"};
  seen.add(error);
  const result:Entry={};
  for(const field of ["name","message","code","errno","syscall","hostname","address","port","status","request_id"]) {
    if(error[field]!==undefined) result[field]=typeof error[field]==="number" ? error[field] : clean(error[field]);
  }
  if(error.stack) result.stack=clean(String(error.stack).split("\n").slice(0,7).join("\n"));
  if(error.cause) result.cause=serializeError(error.cause,clean,depth+1,seen);
  if(Array.isArray(error.errors)) result.errors=error.errors.slice(0,8).map((e:any)=>serializeError(e,clean,depth+1,seen));
  return result;
}
function classify(error?:any,status?:number,signal?:AbortSignal): string {
  if(signal?.aborted) return signal.reason?.name==="TimeoutError" ? "deadline" : "cancelled";
  if(status===401 || status===403) return "auth_or_access";
  if(status===429) return "rate_limit";
  if(status===408 || status===504) return "upstream_timeout";
  if(status && status>=500) return "upstream_server_error";
  if(status && status>=400) return "request_rejected";
  const parts:string[]=[];
  const visited=new Set<any>();
  const walk=(e:any)=>{if(!e || visited.has(e)||visited.size>16)return;visited.add(e);parts.push(String(e.code??""),String(e.name??""),String(e.message??""));walk(e.cause);if(Array.isArray(e.errors))e.errors.forEach(walk);};
  walk(error);const text=parts.join(" ");
  if(/CONNECT_TIMEOUT|connect.*timed? ?out/i.test(text))return "connection_timeout";
  if(/ENOTFOUND|EAI_AGAIN/.test(text))return "dns";
  if(/CERT_|TLS|SSL/.test(text))return "tls";
  if(/ECONNRESET|UND_ERR_SOCKET/.test(text))return "connection_reset";
  if(/ECONNREFUSED/.test(text))return "connection_refused";
  if(/timeout|timed? ?out/i.test(text))return "timeout";
  if(/abort/i.test(text))return "cancelled";
  return "unknown";
}
async function readErrorEnvelope(response:Response,clean:(x:unknown)=>string|undefined):Promise<Entry|undefined> {
  const reader=response.body?.getReader();
  if(!reader) return;
  const chunks:Uint8Array[]=[];let length=0;
  let timer:ReturnType<typeof setTimeout>|undefined;
  try {
    const read=async()=>{
      while(length<16384) {
        const part=await reader.read();if(part.done)break;
        chunks.push(part.value.slice(0,16384-length));length+=part.value.byteLength;
      }
      const parsed=JSON.parse(Buffer.concat(chunks).toString("utf8"));
      const error=parsed.error ?? parsed.base_resp ?? parsed;
      if(!error || typeof error!=="object")return undefined;
      const result:Entry={};
      for(const key of ["type","code","message","status_code","status_msg"]) {
        if(typeof error[key]==="string" || typeof error[key]==="number")result[key]=clean(error[key]);
      }
      return Object.keys(result).length ? result : undefined;
    };
    return await Promise.race([read(),new Promise<undefined>(resolve=>{timer=setTimeout(()=>resolve(undefined),1000);timer.unref();})]);
  } catch {return undefined;} finally {if(timer)clearTimeout(timer);void reader.cancel().catch(()=>{});}
}

function classifyModelError(message:unknown):string {
  const text=String(message ?? "");
  if(/refus|sensitive|content.?filter|safety/i.test(text))return "model_refusal";
  if(/quota|insufficient.balance|credit.balance|payment.required/i.test(text))return "quota_exhausted";
  if(/rate.?limit|\b429\b/i.test(text))return "rate_limit";
  if(/\b40[13]\b|invalid.*api.?key|authentication|unauthori[sz]ed/i.test(text))return "auth_or_access";
  if(/context.*(limit|length|window|exceed)|too.many.tokens/i.test(text))return "context_limit";
  if(/model.*(not.found|not.available|does.not.exist|unavailable)/i.test(text))return "model_unavailable";
  const category=classify({message:text});
  return category==="unknown" ? "sdk_error" : category;
}

/** Keep the systemd-owned listening socket open across process restarts. */
export function serverListenOptions(env: NodeJS.ProcessEnv, pid: number, port: number, host: string) {
  if (env.LISTEN_PID !== String(pid) || !env.LISTEN_FDS || env.LISTEN_FDS === "0") {
    return { port, host };
  }
  if (env.LISTEN_FDS !== "1") throw new Error("Expected exactly one systemd listening socket");
  return { fd: 3, host: "0.0.0.0", exclusive: true };
}

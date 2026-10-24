import { describe, expect, it } from "vitest";
import { serverListenOptions } from "./systemdSocket.js";
describe("systemd socket activation", () => {
 it("keeps ordinary startup without socket activation", () => {
  expect(serverListenOptions({}, 123, 3001, "0.0.0.0")).toEqual({port:3001,host:"0.0.0.0"});
 });
 it("uses inherited descriptor only for this process", () => {
  expect(serverListenOptions({LISTEN_PID:"123",LISTEN_FDS:"1"},123,3001,"0.0.0.0")).toEqual({fd:3,host:"0.0.0.0",exclusive:true});
 });
 it("ignores descriptors belonging to the parent process", () => {
  expect(serverListenOptions({LISTEN_PID:"122",LISTEN_FDS:"1"},123,3001,"0.0.0.0")).toEqual({port:3001,host:"0.0.0.0"});
 });
 it("rejects ambiguous activation rather than silently binding another listener", () => {
  expect(()=>serverListenOptions({LISTEN_PID:"123",LISTEN_FDS:"2"},123,3001,"0.0.0.0")).toThrow(/one/);
 });
});

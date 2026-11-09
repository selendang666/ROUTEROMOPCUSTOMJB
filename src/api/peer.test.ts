import { describe, expect, test } from "bun:test";
import { verifyTrustedPeerIdentity } from "./peer.js";

describe("verifyTrustedPeerIdentity", () => {
  test("rejects missing or short configured tokens", () => {
    const headers = new Headers({ "x-ohmyomop-router-peer-token": "token" });
    expect(verifyTrustedPeerIdentity(headers, undefined)).toEqual({ trusted: false, clientIp: null });
    expect(verifyTrustedPeerIdentity(headers, "short-token")).toEqual({ trusted: false, clientIp: null });
  });

  test("accepts the exact token and a valid peer IP", () => {
    const token = "0123456789abcdef0123456789abcdef";
    const headers = new Headers({
      "x-ohmyomop-router-peer-token": token,
      "x-ohmyomop-router-real-ip": "203.0.113.10",
    });
    expect(verifyTrustedPeerIdentity(headers, token)).toEqual({ trusted: true, clientIp: "203.0.113.10" });
  });

  test("keeps trust while dropping malformed peer IPs", () => {
    const token = "0123456789abcdef0123456789abcdef";
    const headers = new Headers({
      "x-ohmyomop-router-peer-token": token,
      "x-ohmyomop-router-real-ip": "not-an-ip",
    });
    expect(verifyTrustedPeerIdentity(headers, token)).toEqual({ trusted: true, clientIp: null });
  });
});

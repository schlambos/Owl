import { describe, expect, test } from "bun:test";
import { basicAuthHeader, openCodeAuthFromEnv, sanitizeOpenCodeError } from "./security";

describe("OpenCode security context", () => {
  test("password enables Basic auth and username defaults to opencode", () => {
    const auth = openCodeAuthFromEnv({ OPENCODE_SERVER_PASSWORD: "secret" });
    expect(auth).toEqual({ username: "opencode", password: "secret" });
    expect(basicAuthHeader(auth)).toBe(
      `Basic ${Buffer.from("opencode:secret").toString("base64")}`,
    );
  });

  test("username alone does not enable auth", () => {
    expect(openCodeAuthFromEnv({ OPENCODE_SERVER_USERNAME: "operator" })).toBeUndefined();
  });

  test("sanitizer removes explicit password, auth header and URL credentials", () => {
    const message = sanitizeOpenCodeError(
      "http://user:pw@example.test/x Authorization: Basic dXNlcjpwdw== password=verysecret",
      ["verysecret"],
    );
    expect(message).not.toContain("verysecret");
    expect(message).not.toContain("dXNlcjpwdw==");
    expect(message).not.toContain("user:pw");
  });
});

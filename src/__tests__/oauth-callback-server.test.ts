import { describe, expect, it, vi } from "vitest";

// Never let this test launch a real browser at auth.x.ai.
vi.mock("node:child_process", () => ({ exec: vi.fn() }));

const { loginGrok } = await import("../oauth/grok.js");

// Regression: the Grok login raced the callback server's bind against a single
// setImmediate tick and threw "The local OAuth callback server did not start."
// whenever the listen callback had not fired yet — which is most of the time,
// since binding a socket is real async I/O. The give-away in the field was the
// error printing BEFORE the "Local server listening on ..." line it claimed had
// never happened.

interface Started { uri: string; statuses: string[]; login: Promise<unknown> }

/**
 * Drives loginGrok until it has emitted the authorization URL, and reads the
 * redirect URI back out of that URL — so the test asserts on what the browser
 * would actually be sent to, not on an intermediate status line.
 */
async function startLogin(): Promise<Started> {
  const statuses: string[] = [];
  let resolveUri: (uri: string) => void = () => {};
  const uriPromise = new Promise<string>((resolve) => {
    resolveUri = resolve;
  });

  const login = loginGrok(
    {
      onStatus: (message) => {
        statuses.push(message);
        const authUrl = message.match(/(https:\/\/auth\.x\.ai\/\S+)/)?.[1];
        if (!authUrl) return;
        const redirectUri = new URL(authUrl).searchParams.get("redirect_uri");
        if (redirectUri) resolveUri(redirectUri);
      },
    },
    { fetch: (async () => new Response("{}", { status: 200 })) as never },
  );
  login.catch(() => {});

  return { uri: await uriPromise, statuses, login };
}

describe("grok OAuth callback server", () => {
  it("builds the authorization URL around a bound redirect URI", async () => {
    const { uri, statuses, login } = await startLogin();

    expect(uri).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/);
    // Under the old ordering this point was never reached: login threw before
    // ever emitting an authorization URL.
    const authUrl = statuses.find((message) => message.includes("auth.x.ai"));
    expect(authUrl).toBeDefined();
    expect(authUrl).toContain(encodeURIComponent(uri));
    expect(statuses.join("\n")).not.toContain("did not start");

    // Unblock the pending login so the server closes.
    await fetch(`${uri}?error=cancelled&error_description=test+over`).catch(() => {});
    await login.catch(() => {});
  }, 30_000);

  it("is actually accepting connections on the advertised port", async () => {
    const { uri, login } = await startLogin();

    // If the URI were advertised before the socket was bound, this would
    // ECONNREFUSED — precisely the failure the old ordering risked.
    const response = await fetch(`${uri}?error=access_denied&error_description=declined`);
    expect(response.status).toBe(400);
    expect(await response.text()).toContain("declined");

    await expect(login).rejects.toThrow(/declined/);
  }, 30_000);
});

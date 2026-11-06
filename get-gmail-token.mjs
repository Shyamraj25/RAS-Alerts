// One-time helper: authorizes the sender Gmail account and saves its refresh
// token to .gmail-token.json (ignored by Git). It never prints secret values.
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { OAuth2Client } from "google-auth-library";

const execFileAsync = promisify(execFile);
const credentialsPath = "credentials.json";
const tokenPath = ".gmail-token.json";
const gmailSendScope = "https://www.googleapis.com/auth/gmail.send";

async function openSystemBrowser(url) {
  const [command, args] = process.platform === "win32"
    ? ["rundll32.exe", ["url.dll,FileProtocolHandler", url]]
    : process.platform === "darwin"
      ? ["open", [url]]
      : ["xdg-open", [url]];
  try {
    await execFileAsync(command, args);
  } catch {
    process.stdout.write(`Open this URL in your browser:\n${url}\n`);
  }
}

let credentials;
try {
  credentials = JSON.parse(await readFile(credentialsPath, "utf8"));
} catch (error) {
  throw new Error(
    `Could not read ${credentialsPath}. Download the Desktop OAuth client JSON from Google Cloud and save it here with that name. (${error.message})`,
  );
}
const client = credentials.installed;
if (!client?.client_id || !client?.client_secret) {
  throw new Error(
    `${credentialsPath} must be a "Desktop app" OAuth client JSON file.`,
  );
}

const oauthClient = new OAuth2Client(client.client_id, client.client_secret);
const state = randomBytes(32).toString("hex");
let resolveCode;
let rejectCode;
const codePromise = new Promise((resolve, reject) => {
  resolveCode = resolve;
  rejectCode = reject;
});

const server = createServer((request, response) => {
  const callbackUrl = new URL(request.url, "http://127.0.0.1");
  if (callbackUrl.pathname !== "/oauth2callback") {
    response.writeHead(404).end("Not found");
    return;
  }
  const code = callbackUrl.searchParams.get("code");
  if (callbackUrl.searchParams.get("state") !== state || !code) {
    response.writeHead(400, { "Content-Type": "text/plain" })
      .end("Authorization failed. Close this tab and run the helper again.");
    rejectCode(
      new Error(
        `Google authorization failed: ${callbackUrl.searchParams.get("error") ?? "state mismatch or missing code"}`,
      ),
    );
    return;
  }
  response.writeHead(200, { "Content-Type": "text/plain" })
    .end("Gmail authorization complete. You can close this tab.");
  resolveCode(code);
});

await new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(0, "127.0.0.1", resolve);
});
const redirectUri = `http://127.0.0.1:${server.address().port}/oauth2callback`;
const timeout = setTimeout(
  () => rejectCode(new Error("Gmail authorization timed out after five minutes.")),
  5 * 60 * 1000,
);

try {
  process.stdout.write(
    "Sign in to the SENDER Gmail account in the browser and allow sending email.\n",
  );
  await openSystemBrowser(
    oauthClient.generateAuthUrl({
      access_type: "offline",
      prompt: "consent",
      scope: [gmailSendScope],
      state,
      redirect_uri: redirectUri,
    }),
  );
  const { tokens } = await oauthClient.getToken({
    code: await codePromise,
    redirect_uri: redirectUri,
  });
  if (!tokens.refresh_token) {
    throw new Error("Google did not return a refresh token. Run the helper again.");
  }
  await writeFile(tokenPath, JSON.stringify(tokens, null, 2), {
    encoding: "utf8",
    mode: 0o600,
  });
  process.stdout.write(
    `Saved the refresh token to ${tokenPath}. Copy it into the GMAIL_REFRESH_TOKEN secret as described in README.md, then delete both credential files.\n`,
  );
} finally {
  clearTimeout(timeout);
  server.close();
}

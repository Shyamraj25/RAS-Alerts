import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { google } from "googleapis";
import { OAuth2Client } from "google-auth-library";
import { chromium } from "playwright";

const portalUrl = "https://placement.iitk.ac.in/login";
const defaultPlacementCycleId = process.env.RAS_RC_ID || "18";
const rowsPerPage = 100;
const portalTimezone = "Asia/Kolkata";
const emailPattern = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;

function requiredSecret(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required GitHub Actions secret: ${name}`);
  }
  return value;
}

// Users are listed in the RAS_USERS variable as "id:alert-email[:cycle-id]"
// entries separated by new lines or commas. Each id needs RAS_EMAIL_<ID> and
// RAS_PASSWORD_<ID> secrets, which the workflow passes by name for a fixed set
// of ids (passing the whole secrets object makes GitHub hold every run).
// Logs are public, so they show only the id.
function readUsers() {
  const entries = (process.env.RAS_USERS ?? "")
    .split(/[\n,;]+/)
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (entries.length === 0) {
    throw new Error(
      "The RAS_USERS Actions variable is empty. Add one id:alert-email line per user.",
    );
  }

  const users = [];
  entries.forEach((entry, index) => {
    const [id, recipient, placementCycleId = defaultPlacementCycleId] = entry
      .split(":")
      .map((part) => part.trim());
    const validId = /^[A-Za-z0-9_]+$/.test(id);
    const secretSuffix = id.toUpperCase();
    users.push({
      // An invalid id is never logged; the entry's line number is used instead.
      id: validId ? id : `line-${index + 1}`,
      validId,
      // Users with the same id would share one state file.
      duplicate: users.some(
        (user) => user.id.toLowerCase() === id.toLowerCase(),
      ),
      email: process.env[`RAS_EMAIL_${secretSuffix}`],
      password: process.env[`RAS_PASSWORD_${secretSuffix}`],
      recipient,
      placementCycleId: placementCycleId || defaultPlacementCycleId,
      statePath: `state/users/${id.toLowerCase()}.json`,
    });
  });
  return users;
}

function validateUser(user) {
  if (!user.validId) {
    throw new Error(
      "This RAS_USERS entry must start with an id made of letters, numbers, or underscores, followed by :alert-email.",
    );
  }
  if (user.duplicate) {
    throw new Error(`RAS_USERS id "${user.id}" is used more than once.`);
  }
  if (!emailPattern.test(user.recipient ?? "")) {
    throw new Error(`Alert email for user "${user.id}" is not a valid address.`);
  }
  if (!/^[A-Za-z0-9_-]+$/.test(user.placementCycleId)) {
    throw new Error(
      `Placement cycle ID for user "${user.id}" must contain only letters, numbers, underscores, or hyphens.`,
    );
  }
  const suffix = user.id.toUpperCase();
  if (!user.email || !user.password) {
    throw new Error(
      `Missing GitHub Actions secret ${user.email ? "" : `RAS_EMAIL_${suffix} `}${user.password ? "" : `RAS_PASSWORD_${suffix}`}. Add it, and use one of the ids the workflow lists (ARPAN, SHYAM, U1 to U10).`,
    );
  }
}

function normalizeCompanyName(name) {
  return name.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function matchingCompany(noticeRow, companies) {
  const normalizedNotice = normalizeCompanyName(noticeRow);
  return companies.find(({ aliases }) =>
    aliases.some((alias) => normalizedNotice.includes(alias)),
  )?.name;
}

const legalSuffixPattern =
  /\b(?:private|pvt|limited|ltd|llp|llc|inc|incorporated|corp|corporation)\b\.?/gi;

function companyAliases(name) {
  // Also match without "(...)" and legal suffixes, so "X Pvt. Ltd" matches "X Private Limited".
  const baseName = name.replace(/\([^)]*\)/g, " ").replace(legalSuffixPattern, " ");
  return [
    ...new Set(
      [
        name,
        baseName,
        ...[...name.matchAll(/\(([^)]+)\)/g)].map((match) => match[1]),
      ]
        .map(normalizeCompanyName)
        .filter((alias) => alias.length >= 3),
    ),
  ];
}

async function waitForSection(page, heading, allowEmpty = false) {
  await page
    .getByRole("heading", { name: heading, exact: true })
    .waitFor({ state: "visible", timeout: 30000 });
  await page.locator('[role="progressbar"]').waitFor({
    state: "hidden",
    timeout: 30000,
  });
  if (!allowEmpty) {
    await page.locator('[role="row"]').nth(1).waitFor({
      state: "visible",
      timeout: 30000,
    });
  }
}

async function setRowsPerPage(page) {
  const pageSizeButton = page.getByRole("button", {
    name: /Rows per page:/,
  }).first();
  await pageSizeButton.waitFor({ state: "visible", timeout: 30000 });
  await pageSizeButton.click();

  const option = page.getByRole("option", {
    name: String(rowsPerPage),
    exact: true,
  });
  if (await option.count()) {
    await option.first().click();
  } else {
    await page.getByText(String(rowsPerPage), { exact: true }).last().click();
  }

  await page
    .getByRole("button", { name: new RegExp(`Rows per page:\\s*${rowsPerPage}`) })
    .first()
    .waitFor({ state: "visible", timeout: 30000 });
}

async function readGridRows(page) {
  return page.locator('[role="row"]').evaluateAll((rows) =>
    rows
      .slice(1)
      .map((row) =>
        [...row.querySelectorAll('[role="cell"]')].map((cell) =>
          cell.innerText.replace(/\s+/g, " ").trim(),
        ),
      )
      .filter((cells) => cells.length > 0 && cells.some(Boolean)),
  );
}

async function signInToRas(page, email, password, placementCycleId) {
  await page.goto(portalUrl, { waitUntil: "domcontentloaded" });
  await page.getByRole("textbox", { name: "Email ID" }).fill(email);
  await page.getByRole("textbox", { name: "Password" }).fill(password);
  await page.getByRole("button", { name: "Sign In", exact: true }).click();

  try {
    await page.waitForURL(
      (url) => !url.pathname.toLowerCase().includes("/login"),
      { timeout: 30000 },
    );
  } catch {
    throw new Error(
      "RAS sign-in did not complete. Check the RAS secrets; this workflow cannot complete an OTP, CAPTCHA, or other interactive challenge.",
    );
  }

  const baseUrl = `https://placement.iitk.ac.in/student/rc/${placementCycleId}`;
  await page.goto(`${baseUrl}/opening`, {
    waitUntil: "domcontentloaded",
  });
  if (new URL(page.url()).pathname.toLowerCase().includes("/login")) {
    throw new Error(
      "RAS accepted sign-in but redirected to login when opening the configured placement cycle. Check the RAS_RC_ID Actions variable.",
    );
  }
  await waitForSection(page, "Job Openings", true);
  return baseUrl;
}

async function readAppliedCompanies(page, baseUrl) {
  await page.goto(`${baseUrl}/applications`, {
    waitUntil: "domcontentloaded",
  });
  if (new URL(page.url()).pathname.toLowerCase().includes("/login")) {
    throw new Error("RAS session ended while opening Your Applications.");
  }
  await waitForSection(page, "Your Applications", true);
  const totalHeading = page.getByRole("heading", {
    name: /^Total Applications\s*:\s*\d+$/,
  });
  await totalHeading.waitFor({ state: "visible", timeout: 30000 });
  const totalApplications = Number(
    (await totalHeading.innerText()).match(/\d+/)[0],
  );
  await setRowsPerPage(page);
  // Give the grid time to render every application row before reading it.
  await page
    .waitForFunction(
      (expected) =>
        document.querySelectorAll('[role="row"]').length - 1 >= expected,
      Math.min(totalApplications, rowsPerPage),
      { timeout: 15000 },
    )
    .catch(() => {});

  const rows = await readGridRows(page);
  return rows
    .map((cells) => cells[0]?.trim())
    .filter(Boolean)
    .map((name) => ({ name, aliases: companyAliases(name) }));
}

async function readNotices(page, baseUrl) {
  await page.goto(`${baseUrl}/notices`, {
    waitUntil: "domcontentloaded",
  });
  if (new URL(page.url()).pathname.toLowerCase().includes("/login")) {
    throw new Error("RAS session ended while opening Notices.");
  }
  await waitForSection(page, "Notices", true);
  await setRowsPerPage(page);
  return (await readGridRows(page)).map((cells) => cells.join(" "));
}

async function readJobOpenings(page, baseUrl) {
  await page.goto(`${baseUrl}/opening`, {
    waitUntil: "domcontentloaded",
  });
  if (new URL(page.url()).pathname.toLowerCase().includes("/login")) {
    throw new Error("RAS session ended while opening Job Opening.");
  }
  await waitForSection(page, "Job Openings", true);
  await setRowsPerPage(page);
  const grids = page.locator('[role="grid"]');
  const openingGrid = grids.first();
  await openingGrid.locator('[role="progressbar"]').waitFor({
    state: "hidden",
    timeout: 30000,
  });
  return openingGrid.locator('[role="row"]').evaluateAll((rows) =>
    rows
      .slice(1)
      .map((row) =>
        [...row.querySelectorAll('[role="cell"]')].map((cell) =>
          cell.innerText.replace(/\s+/g, " ").trim(),
        ),
      )
      .filter((cells) => cells.length > 0 && cells.some(Boolean))
      .map((cells) => cells.join(" ")),
  );
}

// State holds notice text and each user's applied companies. It is stored in
// the Actions cache of a public repository, so it is encrypted at rest with
// AES-256-GCM using a key derived from the RAS_STATE_KEY secret.
function stateKey() {
  return createHash("sha256").update(requiredSecret("RAS_STATE_KEY")).digest();
}

function encryptState(state) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", stateKey(), iv);
  const data = Buffer.concat([
    cipher.update(JSON.stringify(state), "utf8"),
    cipher.final(),
  ]);
  return JSON.stringify({
    v: 1,
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    data: data.toString("base64"),
  });
}

function decryptState(fileContents) {
  const { iv, tag, data } = JSON.parse(fileContents);
  const decipher = createDecipheriv(
    "aes-256-gcm",
    stateKey(),
    Buffer.from(iv, "base64"),
  );
  decipher.setAuthTag(Buffer.from(tag, "base64"));
  return JSON.parse(
    Buffer.concat([
      decipher.update(Buffer.from(data, "base64")),
      decipher.final(),
    ]).toString("utf8"),
  );
}

async function readState(statePath, log) {
  let fileContents;
  try {
    fileContents = await readFile(statePath, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") {
      return null;
    }
    throw new Error(`Could not read notice state: ${error.message}`);
  }

  let state;
  try {
    state = decryptState(fileContents);
  } catch {
    // Most likely RAS_STATE_KEY was changed; start a fresh baseline.
    log("Saved state could not be decrypted (was RAS_STATE_KEY changed?); starting a new baseline.");
    return null;
  }

  try {
    if (
      !Array.isArray(state.seenNotices) ||
      (state.seenOpenings !== undefined && !Array.isArray(state.seenOpenings)) ||
      (state.knownCompanies !== undefined &&
        !Array.isArray(state.knownCompanies))
    ) {
      throw new Error("state file contains an invalid notice/opening baseline.");
    }
    return state;
  } catch (error) {
    throw new Error(`Could not read notice state: ${error.message}`);
  }
}

// Removes duplicates, keeping each entry's latest position so rows still on
// the page stay at the end and survive the size limit.
function uniqueLatest(entries) {
  return [...new Set([...entries].reverse())].reverse();
}

async function writeState(statePath, seenNotices, seenOpenings, knownCompanies) {
  await mkdir(dirname(statePath), { recursive: true });
  await writeFile(
    statePath,
    encryptState({
      seenNotices: uniqueLatest(seenNotices).slice(-2000),
      seenOpenings: uniqueLatest(seenOpenings).slice(-2000),
      knownCompanies: uniqueLatest(knownCompanies).slice(-500),
      timezone: portalTimezone,
      updatedAt: new Date().toISOString(),
    }),
    "utf8",
  );
}

function createGmailClient() {
  const oauthClient = new OAuth2Client(
    requiredSecret("GMAIL_CLIENT_ID"),
    requiredSecret("GMAIL_CLIENT_SECRET"),
  );
  oauthClient.setCredentials({
    refresh_token: requiredSecret("GMAIL_REFRESH_TOKEN"),
  });
  return google.gmail({ version: "v1", auth: oauthClient });
}

async function sendEmail(gmail, recipient, { notices, openings }) {
  const subject = [
    openings.length ? `${openings.length} new job opening(s)` : "",
    notices.length ? `${notices.length} matching notice(s)` : "",
  ].filter(Boolean).join(" and ");
  const body = [
    ...(openings.length
      ? [
          "New eligible job opening(s) appeared in the RAS Job Opening section:",
          "",
          ...openings.map((opening) => `- ${opening}`),
          "",
        ]
      : []),
    ...(notices.length
      ? [
          "New RAS notice(s) match companies in your Your Applications list:",
          "",
          ...notices.map((notice) => `- ${notice}`),
          "",
        ]
      : []),
    "",
    "This message was sent by your RAS GitHub Actions monitor.",
  ].join("\r\n");
  const rawMessage = [
    `To: ${recipient}`,
    `Subject: =?UTF-8?B?${Buffer.from(subject).toString("base64")}?=`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: 8bit",
    "",
    body,
  ].join("\r\n");

  try {
    await gmail.users.messages.send({
      userId: "me",
      requestBody: { raw: Buffer.from(rawMessage).toString("base64url") },
    });
  } catch (error) {
    const oauthError = error.response?.data?.error;
    if (["unauthorized_client", "invalid_client", "invalid_grant"].includes(oauthError)) {
      throw new Error(
        `Gmail authorization failed (${oauthError}). GMAIL_REFRESH_TOKEN must come from the same OAuth client as GMAIL_CLIENT_ID and GMAIL_CLIENT_SECRET, and must not be expired or revoked. Re-copy all three secrets.`,
      );
    }
    throw error;
  }
  return `Sent email alert: ${openings.length} new job opening(s), ${notices.length} matching notice(s).`;
}

async function checkUser(browser, gmail, user) {
  const log = (message) => process.stdout.write(`[${user.id}] ${message}\n`);
  // A separate context per user keeps each RAS login session isolated.
  // The portal shows times in the browser's time zone; the runner uses UTC.
  const context = await browser.newContext({ timezoneId: portalTimezone });
  try {
    const page = await context.newPage();
    page.setDefaultTimeout(30000);
    const baseUrl = await signInToRas(
      page,
      user.email,
      user.password,
      user.placementCycleId,
    );
    const companies = await readAppliedCompanies(page, baseUrl);

    const notices = await readNotices(page, baseUrl);
    const openings = await readJobOpenings(page, baseUrl);
    await processResults(gmail, user, log, { companies, notices, openings });
  } finally {
    await context.close();
  }
}

async function processResults(gmail, user, log, { companies, notices, openings }) {
  const { statePath, recipient } = user;
  const companyNames = companies.map(({ name }) => name);
  const previousState = await readState(statePath, log);
  if (!previousState || previousState.timezone !== portalTimezone) {
    // Saved rows include their displayed time, so rows saved in another time
    // zone would all look new; re-save the baseline instead of emailing them.
    await writeState(statePath, notices, openings, companyNames);
    log(
      `${previousState ? "Baseline re-saved for the new time zone" : "Initial baseline saved"} for ${notices.length} notice(s) and ${openings.length} job opening(s); no email sent.`,
    );
  } else {
    const previousSet = new Set(previousState.seenNotices);
    const newlySeen = notices.filter((notice) => !previousSet.has(notice));
    // A company applied to since the last run gets its existing notices too,
    // since those were already marked seen before the company was applied to.
    // State saved before knownCompanies existed treats current ones as known.
    const knownCompanies = new Set(
      previousState.knownCompanies ?? companyNames,
    );
    const newCompanies = companies.filter(
      ({ name }) => !knownCompanies.has(name),
    );
    const matchingNotices = notices.flatMap((notice) => {
      const company = previousSet.has(notice)
        ? matchingCompany(notice, newCompanies)
        : matchingCompany(notice, companies);
      return company ? [`${company}: ${notice}`] : [];
    });
    if (newCompanies.length > 0) {
      // Logs are public: report the count, never the company names.
      log(`${newCompanies.length} newly applied company(ies).`);
    }
    const previousOpeningSet = new Set(previousState.seenOpenings ?? []);
    const newlySeenOpenings = (previousState.seenOpenings
      ? openings.filter((opening) => !previousOpeningSet.has(opening))
      : []);

    if (matchingNotices.length > 0 || newlySeenOpenings.length > 0) {
      log(
        await sendEmail(gmail, recipient, {
          notices: matchingNotices,
          openings: newlySeenOpenings,
        }),
      );
    } else if (newlySeen.length > 0) {
      log(`Found ${newlySeen.length} new notice(s), none for applied companies.`);
    } else {
      log("No new job openings or matching notices.");
    }

    await writeState(
      statePath,
      [...previousState.seenNotices, ...notices],
      [...(previousState.seenOpenings ?? openings), ...openings],
      [...knownCompanies, ...companyNames],
    );
  }
}

// Only the first line of an error is logged, since multi-line Playwright and
// HTTP errors can include page or request details in these public logs.
function shortErrorMessage(error) {
  return String(error?.message ?? error).split("\n")[0].slice(0, 300);
}

const users = readUsers();
stateKey();
const gmail = createGmailClient();
const browser = await chromium.launch({ headless: true });
const failedUsers = [];

try {
  // Users are checked one at a time; a failure for one user (for example a
  // changed RAS password) is reported but does not stop the others.
  for (const user of users) {
    try {
      validateUser(user);
      await checkUser(browser, gmail, user);
    } catch (error) {
      failedUsers.push(user.id);
      process.stderr.write(`[${user.id}] FAILED: ${shortErrorMessage(error)}\n`);
    }
  }
} finally {
  await browser.close();
}

if (failedUsers.length > 0) {
  process.stderr.write(
    `Check failed for ${failedUsers.length} of ${users.length} user(s): ${failedUsers.join(", ")}.\n`,
  );
  process.exitCode = 1;
}

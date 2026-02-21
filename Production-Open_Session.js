// =====================================================
// 📦 IMPORTS
// =====================================================
const axios = require("axios");
const fs = require("fs");
const path = require("path");
const XLSX = require("xlsx");
const nodemailer = require("nodemailer");
const { MongoClient, ObjectId } = require("mongodb");

// =====================================================
// 🔐 CONFIG
// =====================================================
const BASE_URL = "https://appapi.chargecloud.net/v1/report/bookinghistory";

const TOKEN = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiI2NDJlZTBkNmU1MmIzYjg1MWNmN2MxMjkiLCJhdXRoVG9rZW5WZXJzaW9uIjoidjEiLCJpYXQiOjE3NzEzMTc4MzgsImV4cCI6MTc3MjYxMzgzOCwidHlwZSI6ImFjY2VzcyJ9.qO5zt2MqTSSzuSLV8muFoO6ePafkr1sArArPhXISttQ";
const MONGO_URI = "mongodb+srv://IT_INTERN:ITINTERN123@cluster1.0pycd.mongodb.net/chargezoneprod";
const RUN_MODE = process.argv[2] || "MORNING";

// =====================================================
// LOAD PARTY CONFIG
// =====================================================
const partyConfig = JSON.parse(
  fs.readFileSync(path.join(__dirname, "partyConfig.json"), "utf8")
);

// =====================================================
// MAILER
// =====================================================
const transporter = nodemailer.createTransport({
  service: "gmail",
  auth: {
    user: "darshraj3104@gmail.com",
    pass: "ddxg ddtb fiiz mygh",
  },
});

const mongoClient = new MongoClient(MONGO_URI);
let db;

function log(step, msg) {
  console.log(`[${new Date().toISOString()}] [${step}] ${msg}`);
}

// =====================================================
// FOLDERS
// =====================================================
const today = new Date().toISOString().split("T")[0];
const baseDir = path.join(__dirname, "DailyReports", today);
const partyDir = path.join(__dirname, "DailyReports", "PartyReports");

if (!fs.existsSync(baseDir)) fs.mkdirSync(baseDir, { recursive: true });
if (!fs.existsSync(partyDir)) fs.mkdirSync(partyDir, { recursive: true });

// =====================================================
// 🕒 TIME CALCULATION (STABLE IST - SAME ON EC2 & LOCAL)
// =====================================================
// =====================================================
// 🔐 REQUEST HEADERS (MISSING)
// =====================================================
const headers = {
  Authorization: `Bearer ${TOKEN}`,
  "Content-Type": "application/json",
};

// Current UTC timestamp
const nowUTC = new Date();

// Convert UTC → IST using fixed offset (+5h30m)
const IST_OFFSET = 5.5 * 60 * 60 * 1000;
const nowIST = new Date(nowUTC.getTime() + IST_OFFSET);

// First day of month in IST (keep logic same)
const firstDayIST = new Date(
  nowIST.getFullYear(),
  nowIST.getMonth(),
  1
);

// Current IST minus 5 hours (LOGIC UNCHANGED)
const bufferTimeIST = new Date(nowIST.getTime() - 5 * 60 * 60 * 1000);

// IMPORTANT:
// API expects ISO → always send UTC ISO
const filterBody = {
  from: new Date(firstDayIST.getTime() - IST_OFFSET).toISOString(),
  to: new Date(bufferTimeIST.getTime() - IST_OFFSET).toISOString(),
  report: "bookingHistory",
  status: "in_progress",
  is_emsp_based_booking: false,
  is_ocpi_based_booking: true,
};

// =====================================================
// DOWNLOAD EXCEL
// =====================================================
async function downloadExcel() {
  try {
    log("EXCEL", "Downloading report...");

    const res = await axios({
      method: "POST",
      url: BASE_URL,
      headers,
      responseType: "arraybuffer",
      data: { ...filterBody, excel: true },
    });

    const filePath = path.join(baseDir, `bookingHistory_${Date.now()}.xlsx`);
    fs.writeFileSync(filePath, res.data);

    log("EXCEL", "Download success");
    return filePath;
  } catch (err) {
    log("ERROR", err.message);
    return null;
  }
}

// =====================================================
// BULK DB FETCH
// =====================================================
async function fetchBulkBookingData(bookingIds) {
  const objectIds = bookingIds.filter(Boolean).map(id => new ObjectId(id));

  const bookings = await db
    .collection("chargerbookings")
    .find({ _id: { $in: objectIds } })
    .toArray();

  const map = {};
  bookings.forEach((b) => {
    map[String(b._id)] = {
      status: b.status,
      ocpiCredential: String(b.ocpiCredential),
    };
  });

  return map;
}

// =====================================================
// CREATE PARTY FILES (UPDATED - UAT LOGIC APPLIED SAFELY)
// =====================================================
async function createPartyWiseFiles(mainFile) {

  log("PARTY", "Processing Excel rows...");

  const wb = XLSX.readFile(mainFile);
  const sheet = wb.Sheets[wb.SheetNames[0]];

  // ✅ Same header handling as UAT
  const rows = XLSX.utils.sheet_to_json(sheet, {
    range: 2,
    defval: "",
  });

  // ✅ KEEP existing PROD behaviour (mobile filter)
  const filtered = rows.filter((r) => r["Mobile No."]);

  const bookingIds = filtered.map((r) => r["Booking Id"]).filter(Boolean);
  const bookingMap = await fetchBulkBookingData(bookingIds);

  const partyMap = {};

  for (const row of filtered) {

    const dbBooking = bookingMap[row["Booking Id"]];
    if (!dbBooking) continue; // skip if DB not found

    const dbStatus = String(dbBooking.status || "").toLowerCase();

    // ✅ NEW (same as UAT)
    // Skip closed sessions BEFORE writing
    if (dbStatus === "completed" || dbStatus === "cancelled") continue;

    const partyId = row["Party Id"] || "UNKNOWN";
    if (!partyMap[partyId]) partyMap[partyId] = [];

    partyMap[partyId].push({
      "Booking Id": row["Booking Id"],
      status: dbStatus, // 🔵 DB status instead of Excel
      Notification: "",
      "Reminder 1": "",
      "Final Reminder": "",
      "Escalated": "",
      "Final Status": dbStatus,
    });
  }

  // =====================================================
  // WRITE PARTY FILES (UNCHANGED STRUCTURE)
  // =====================================================
  for (const partyId of Object.keys(partyMap)) {

    const filePath = path.join(partyDir, `PARTY_${partyId}.xlsx`);

    let existing = [];
    if (fs.existsSync(filePath)) {
      const oldWB = XLSX.readFile(filePath);
      existing = XLSX.utils.sheet_to_json(
        oldWB.Sheets[oldWB.SheetNames[0]],
        { defval: "" }
      );
    }

    const map = new Map();
    existing.forEach((r) => map.set(r["Booking Id"], r));

    partyMap[partyId].forEach((newRow) => {
      if (!map.has(newRow["Booking Id"])) {
        map.set(newRow["Booking Id"], newRow);
      }
    });

    const finalData = Array.from(map.values());

    const newWB = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(
      newWB,
      XLSX.utils.json_to_sheet(finalData),
      "PartyData"
    );

    XLSX.writeFile(newWB, filePath);
    log("PARTY", `Updated → ${partyId}`);
  }
}

// =====================================================
// EMAIL ENGINE (UPDATED WITH DB SYNC)
// =====================================================
async function processPartyEmails() {

  log("MAIL", `Reminder Engine Mode → ${RUN_MODE}`);

  const files = fs.readdirSync(partyDir).filter((f) => f.endsWith(".xlsx"));
  const now = new Date();
  const todayDate = now.toISOString().split("T")[0];

  for (const file of files) {

    const partyId = file.replace("PARTY_", "").replace(".xlsx", "");
    const config = partyConfig[partyId];
    if (!config || !config.emails.length) continue;

    const emails = config.emails.join(",");
    const ccEmails = config.cc?.join(",");
    const filePath = path.join(partyDir, file);

    const wb = XLSX.readFile(filePath);
    let data = XLSX.utils.sheet_to_json(
      wb.Sheets[wb.SheetNames[0]],
      { defval: "" }
    );

    // 🔵 LIVE DB FETCH
    const allIds = data.map(r => r["Booking Id"]).filter(Boolean);
    const liveBookingMap = await fetchBulkBookingData(allIds);

    const notifyIDs = [];
    const reminderIDs = [];
    const finalIDs = [];

    let threadId = data.find(r => r.ThreadDate === todayDate)?.ThreadId || null;

    for (const row of data) {

      const live = liveBookingMap[row["Booking Id"]];

      if (live) {
        row["Final Status"] = live.status;

        if (live.status === "completed") {
          row.ThreadClosed = "YES";
          continue;
        }
      }

      if (row.status !== "in_progress") continue;
      if (row.ThreadClosed === "YES") continue;

      const notifTime = row.Notification ? new Date(row.Notification) : null;
      const remTime = row["Reminder 1"] ? new Date(row["Reminder 1"]) : null;

      if (RUN_MODE === "MORNING") {

        if (!row.Notification) {
          row.Session = "MORNING";
          row.ThreadDate = todayDate;
          notifyIDs.push(row["Booking Id"]);
        }
        else if (
          row.Session === "MORNING" &&
          !row["Reminder 1"] &&
          notifTime &&
          now - notifTime >= 24 * 60 * 60 * 1000
        ) {
          reminderIDs.push(row["Booking Id"]);
        }
        else if (
          row.Session === "MORNING" &&
          !row["Final Reminder"] &&
          remTime &&
          now - remTime >= 24 * 60 * 60 * 1000
        ) {
          finalIDs.push(row["Booking Id"]);
        }
      }

      if (RUN_MODE === "EVENING") {

        if (!row.Notification) {
          row.Session = "EVENING";
          row.ThreadDate = todayDate;
          notifyIDs.push(row["Booking Id"]);
        }
        else if (
          row.Session === "EVENING" &&
          !row["Reminder 1"] &&
          notifTime &&
          now - notifTime >= 24 * 60 * 60 * 1000
        ) {
          reminderIDs.push(row["Booking Id"]);
        }
        else if (
          row.Session === "EVENING" &&
          !row["Final Reminder"] &&
          remTime &&
          now - remTime >= 24 * 60 * 60 * 1000
        ) {
          finalIDs.push(row["Booking Id"]);
        }
      }
    }

    // =====================================================
    // 📧 SEND MAIL FUNCTION (UPDATED CONTENT)
    // =====================================================
    async function send(type, ids) {

      if (!ids.length) return;

      log("MAIL", `${type} → ${partyId} (${ids.length})`);

      const lifecycle =
        RUN_MODE === "MORNING"
          ? "Morning Cycle (08:00 AM IST)"
          : "Evening Cycle (05:00 PM IST)";

      // Build simple table rows
      const rowsHTML = ids.map(id => {

        const row = data.find(r => r["Booking Id"] === id);

        const date =
          row?.Notification ||
          row?.["Reminder 1"] ||
          row?.ThreadDate ||
          "N/A";

        return `
          <tr>
            <td style="border:1px solid #ccc;padding:5px;">${id}</td>
            <td style="border:1px solid #ccc;padding:5px;">${date}</td>
            <td style="border:1px solid #ccc;padding:5px;">${row?.["Final Status"] || "in_progress"}</td>
          </tr>
        `;
      }).join("");

      const htmlContent = `
        <div style="font-family:Arial;font-size:14px;">
          <p>Hello Team,</p>

          <p>
            <b>${type}</b> triggered for Party <b>${partyId}</b>.
          </p>

          <p>
            Lifecycle: ${lifecycle}<br/>
            Date: ${todayDate}
          </p>

          <p>Below sessions are still IN PROGRESS:</p>

          <table style="border-collapse:collapse;">
            <tr style="background:#f2f2f2;">
              <th style="border:1px solid #ccc;padding:5px;">Booking ID</th>
              <th style="border:1px solid #ccc;padding:5px;">Lifecycle Date</th>
              <th style="border:1px solid #ccc;padding:5px;">Status</th>
            </tr>
            ${rowsHTML}
          </table>

          <p>Please verify and close sessions if completed.</p>

          <hr/>
          <p style="color:#666;font-size:12px;">
            Automated Mail - Chargezone Reminder Engine
          </p>
        </div>
      `;

      const mailOptions = {
        from: "noreply@chargezone.co.in",
        to: emails,
        cc: ccEmails,
        subject: `Open Sessions - ${partyId} - ${todayDate}`,
        html: htmlContent
      };

      if (threadId) {
        mailOptions.inReplyTo = threadId;
        mailOptions.references = threadId;
      }

      const info = await transporter.sendMail(mailOptions);

      if (!threadId) {
        threadId = info.messageId;
        data.forEach(r => {
          if (r.ThreadDate === todayDate) r.ThreadId = threadId;
        });
      }
    }

    await send("Notification", notifyIDs);
    await send("Reminder 1", reminderIDs);
    await send("Final Reminder", finalIDs);

    data.forEach((r) => {

      if (notifyIDs.includes(r["Booking Id"]) && !r.Notification)
        r.Notification = now.toISOString();

      if (reminderIDs.includes(r["Booking Id"]))
        r["Reminder 1"] = now.toISOString();

      if (finalIDs.includes(r["Booking Id"]))
        r["Final Reminder"] = now.toISOString();
    });

    const newWB = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(newWB, XLSX.utils.json_to_sheet(data), "PartyData");
    XLSX.writeFile(newWB, filePath);
  }
}

// =====================================================
// MAIN
// =====================================================
async function runAutomation() {

  try {

    await mongoClient.connect();
    db = mongoClient.db("chargezoneprod");

    log("START", "Automation Started");

    const mainFile = await downloadExcel();
    if (!mainFile) {
      await mongoClient.close();
      process.exit(0);
    }

    await createPartyWiseFiles(mainFile);
    await processPartyEmails();

    log("END", "Completed");

    await mongoClient.close();
    process.exit(0);

  } catch (err) {

    console.error(err);

    try { await mongoClient.close(); } catch {}

    process.exit(1);
  }
}

runAutomation();
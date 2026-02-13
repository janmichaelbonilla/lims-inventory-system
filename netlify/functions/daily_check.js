const admin = require("firebase-admin");
const sgMail = require("@sendgrid/mail");
const { schedule } = require("@netlify/functions");

const handler = async function(event, context) {
  console.log("⏰ Running Smart Expiry Check...");

  if (!process.env.FIREBASE_SERVICE_ACCOUNT) {
    console.error("❌ ERROR: FIREBASE_SERVICE_ACCOUNT is missing.");
    return { statusCode: 500 };
  }

  const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
  const DB_URL = process.env.FIREBASE_DB_URL;
  const SENDGRID_KEY = process.env.SENDGRID_API_KEY;
  const SENDER_EMAIL = process.env.SENDER_EMAIL;

  if (!admin.apps.length) {
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
      databaseURL: DB_URL
    });
  }

  const db = admin.database();
  sgMail.setApiKey(SENDGRID_KEY);

  const invRef = db.ref("inventory_live_v1");
  const contactsRef = db.ref("study_contacts");
  
  const [invSnap, contactSnap] = await Promise.all([invRef.once("value"), contactsRef.once("value")]);
  const inventory = invSnap.val() || {};
  const contacts = contactSnap.val() || {};

  const today = new Date();
  const alerts = {}; 
  
  // MILESTONES: Only alert on exactly these days remaining
  const MILESTONES = [30, 15, 5, 0];

  Object.values(inventory).forEach(item => {
    if (item.status === 'Available' && item.expiry) {
      const expDate = new Date(item.expiry);
      const diffTime = expDate - today;
      // Calculate exact difference in days (rounding up ensures 5.9 days counts as 6, etc.)
      const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));

      // LOGIC CHANGE: Only add to list if diffDays matches a milestone exactly
      if (MILESTONES.includes(diffDays)) {
        const study = item.study || "Unknown";
        if (!alerts[study]) alerts[study] = [];
        
        // Customize urgency label based on days
        let urgency = "⚠️ Warning";
        if (diffDays === 15) urgency = "🟠 Reminder";
        if (diffDays === 5) urgency = "🔴 URGENT";
        if (diffDays <= 0) urgency = "☠️ EXPIRED";

        alerts[study].push({
          barcode: item.barcode,
          visit: item.visit,
          expiry: item.expiry,
          daysLeft: diffDays,
          label: urgency
        });
      }
    }
  });

  const emailPromises = [];

  for (const [studyName, items] of Object.entries(alerts)) {
    let recipient = null;
    Object.values(contacts).forEach(c => {
      if(c.name.toLowerCase() === studyName.toLowerCase()) recipient = c.email;
    });

    if (recipient) {
      const itemList = items.map(i => 
        `<li><strong>${i.label}:</strong> ${i.barcode} (${i.visit}) - Expires ${i.expiry} (${i.daysLeft} days)</li>`
      ).join("");

      const msg = {
        to: recipient,
        from: SENDER_EMAIL, 
        subject: `LIMS Alert: Status Update for ${studyName}`,
        html: `
          <h3>Inventory Status Update</h3>
          <p>The following items have reached an expiration milestone today:</p>
          <ul>${itemList}</ul>
          <p>Please check the LIMS inventory.</p>
        `,
      };
      emailPromises.push(sgMail.send(msg));
    }
  }

  await Promise.all(emailPromises);
  console.log("✅ Smart Check Complete.");
  return { statusCode: 200 };
};

module.exports.handler = schedule("0 8 * * *", handler);

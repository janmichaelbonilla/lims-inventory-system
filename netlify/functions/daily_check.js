const admin = require("firebase-admin");
const sgMail = require("@sendgrid/mail");
const { schedule } = require("@netlify/functions");

const handler = async function(event, context) {
  console.log("⏰ Running Smart Expiry Check...");

  // 1. SETUP KEYS
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

  // 2. FETCH DATA
  const invRef = db.ref("inventory_live_v1");
  const contactsRef = db.ref("study_contacts");
  
  const [invSnap, contactSnap] = await Promise.all([invRef.once("value"), contactsRef.once("value")]);
  const inventory = invSnap.val() || {};
  const contacts = contactSnap.val() || {};

  const today = new Date();
  const alerts = {}; 
  
  // MILESTONES: Approaching expiry triggers (Standard warnings)
  const MILESTONES = [30, 15, 5];

  Object.values(inventory).forEach(item => {
    if (item.status === 'Available' && item.expiry) {
      const expDate = new Date(item.expiry);
      const diffTime = expDate - today;
      const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));

      // LOGIC: 
      // 1. If days remaining matches a Milestone (30, 15, 5) -> Send Alert
      // 2. OR if days is 0 or less (Expired) -> Send Daily Alert
      if (MILESTONES.includes(diffDays) || diffDays <= 0) {
        
        const study = item.study || "Unknown";
        if (!alerts[study]) alerts[study] = [];
        
        let urgency = "⚠️ Warning";
        if (diffDays === 15) urgency = "🟠 Reminder";
        if (diffDays === 5) urgency = "🔴 URGENT";
        if (diffDays <= 0) urgency = "☠️ EXPIRED"; // Triggers every day it remains negative

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

  // 3. SEND EMAILS
  const emailPromises = [];

  for (const [studyName, items] of Object.entries(alerts)) {
    let recipient = null;
    Object.values(contacts).forEach(c => {
      if(c.name.toLowerCase() === studyName.toLowerCase()) recipient = c.email;
    });

    if (recipient) {
      console.log(`📧 Sending daily nag for ${studyName} to ${recipient}`);
      
      const itemList = items.map(i => 
        `<li><strong>${i.label}:</strong> ${i.barcode} (${i.visit}) - Expires ${i.expiry} (${i.daysLeft} days)</li>`
      ).join("");

      const msg = {
        to: recipient,
        from: {
          email: SENDER_EMAIL,
          name: "LIMS Inventory System"
        },
        subject: `⚠️ ACTION REQUIRED: Expired/Expiring Kits in ${studyName}`,
        html: `
          <div style="font-family: sans-serif; color: #333;">
            <h2 style="color: #d32f2f;">Daily Inventory Status</h2>
            <p>The following items require your attention:</p>
            <ul>${itemList}</ul>
            <p><em>Note: Expired items will trigger this email daily until removed from inventory.</em></p>
            <hr>
            <p style="font-size: 0.8em; color: #666;">Automated LIMS Notification.</p>
          </div>
        `,
      };
      emailPromises.push(sgMail.send(msg));
    }
  }

  await Promise.all(emailPromises);
  console.log("✅ Check Complete.");
  return { statusCode: 200 };
};

module.exports.handler = schedule("0 8 * * *", handler);

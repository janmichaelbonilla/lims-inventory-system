const admin = require("firebase-admin");
const sgMail = require("@sendgrid/mail");
const { schedule } = require("@netlify/functions");

// 1. SETUP KEYS (These pull from Netlify Environment Variables)
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
const DB_URL = process.env.FIREBASE_DB_URL;
const SENDGRID_KEY = process.env.SENDGRID_API_KEY;
const SENDER_EMAIL = process.env.SENDER_EMAIL;

// Initialize Firebase
if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    databaseURL: DB_URL
  });
}

const db = admin.database();

const handler = async function(event, context) {
  console.log("⏰ Running Daily Expiry Check...");
  sgMail.setApiKey(SENDGRID_KEY);

  // 2. FETCH DATA
  const invRef = db.ref("inventory_live_v1");
  const contactsRef = db.ref("study_contacts");
  
  const [invSnap, contactSnap] = await Promise.all([invRef.once("value"), contactsRef.once("value")]);
  const inventory = invSnap.val() || {};
  const contacts = contactSnap.val() || {};

  // 3. FIND EXPIRING ITEMS
  const today = new Date();
  const alerts = {}; 

  Object.values(inventory).forEach(item => {
    if (item.status === 'Available' && item.expiry) {
      const expDate = new Date(item.expiry);
      const diffTime = expDate - today;
      const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));

      if (diffDays <= 30) {
        const study = item.study || "Unknown";
        if (!alerts[study]) alerts[study] = [];
        
        alerts[study].push({
          barcode: item.barcode,
          visit: item.visit,
          expiry: item.expiry,
          daysLeft: diffDays
        });
      }
    }
  });

  // 4. SEND EMAILS
  const emailPromises = [];

  for (const [studyName, items] of Object.entries(alerts)) {
    let recipient = null;
    // Find matching contact email
    Object.values(contacts).forEach(c => {
      if(c.name.toLowerCase() === studyName.toLowerCase()) recipient = c.email;
    });

    if (recipient) {
      console.log(`📧 Sending alert for ${studyName} to ${recipient}`);
      
      const itemList = items.map(i => 
        `<li><strong>${i.barcode}</strong> (${i.visit}): Expires ${i.expiry} (${i.daysLeft} days left)</li>`
      ).join("");

      const msg = {
        to: recipient,
        from: SENDER_EMAIL,
        subject: `⚠️ LIMS Alert: Expiring Kits for ${studyName}`,
        html: `
          <h3>Action Required</h3>
          <p>The following kits are expiring soon or have expired:</p>
          <ul>${itemList}</ul>
          <p>Please log in to the LIMS Inventory to process or discard them.</p>
        `,
      };
      emailPromises.push(sgMail.send(msg));
    }
  }

  await Promise.all(emailPromises);
  console.log("✅ Daily Check Complete.");
  return { statusCode: 200 };
};

module.exports.handler = schedule("0 8 * * *", handler);
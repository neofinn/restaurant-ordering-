# Go-live options: hosting, WhatsApp, payments

Checked October 2026. Prices are list prices before GST and change often. Confirm them on each provider's own pricing page before buying; where sources disagreed, that is noted.

---

## 1. Hosting: AWS, Azure, Google Cloud and others

**What the app needs from a server.**
- **A virtual machine.** The app is one always-on Node.js 22 process that keeps all data in one SQLite file on the machine's own disk, plus timers for rider reassignment, review requests, unpaid-order expiry and the Supabase copy.
- **2 vCPU / 4 GB is plenty.** One core handled about 1,700 orders a minute in our load test; the expected peak is about 90 orders an hour.
- **India region.** It means low latency and keeps data in India (DPDP Act).

`deploy/setup.sh` works unchanged on any **Ubuntu 24.04** VM, from every provider below.

| Provider | What to buy | Region | Price / month | Fits? |
|---|---|---|---|---|
| **AWS Lightsail** | 4 GB / 2 vCPU / 80 GB SSD bundle | Mumbai | **$24** (~₹2,000); 2 GB is $12 | ✅ Simplest on AWS. Static IP included. Note: Mumbai bundles get half the data-transfer allowance (2 TB on the 4 GB plan, still far more than needed). Snapshots cost extra. |
| **AWS EC2** | t3.medium / t4g.medium + 30 GB gp3 + Elastic IP | ap-south-1 (Mumbai) | roughly $30–40 incl. disk and public IPv4 charge (not verified to the dollar) | ✅ Works; more knobs than Lightsail for no gain here. |
| **Azure VM** | B2s (2 vCPU, 4 GB) + managed disk + public IP | Central India (Pune) | **$32.70** for the VM alone, plus about $5–10 for disk and IP | ✅ Good if the client already uses Microsoft/Azure, or has credits. |
| **Google Cloud** | e2-medium + disk + static IP | asia-south1 (Mumbai) / asia-south2 (Delhi) | sources disagree: roughly $25–45; use Google's calculator | ✅ Works. The free tier doesn't cover India regions. |
| **DigitalOcean** | 2 GB droplet ($12), 4 GB droplet | Bangalore (BLR1) | $12 for 2 GB; backups +20% | ✅ Simple. The 4 GB price wasn't confirmed in this check. |
| **Hostinger VPS** | KVM 2 (2 vCPU, 8 GB) | India | ~₹700 on a 24-month term | ✅ Cheapest; what DEPLOY.md assumes. |

**Not suitable as they are.**
- **AWS:** App Runner, Elastic Beanstalk and Lambda.
- **Azure:** App Service and Container Apps.
- **Google:** Cloud Run.
- **Render, Railway and Fly.io.**

These either scale to zero (the timers stop) or have no local disk. Their "persistent" storage is a network share (Azure Files, NFS), where SQLite can corrupt. We could move the database to Postgres to use them, but that's a bigger change with no benefit at this size.

**Recommendation.**
- **Client wants a big-name cloud:** AWS Lightsail, Mumbai, 4 GB: $24/month, simple, static IP included, and easy to move to EC2 later.
- **Client already uses Microsoft:** an Azure B2s VM in Central India.
- **Lowest cost:** Hostinger KVM 2.

Every option uses the same setup script, backups and update/rollback commands.

**Per-provider steps before running `setup.sh`:**
- **Lightsail:**
  - create an Ubuntu 24.04 instance in Mumbai;
  - **Networking → attach a static IP**;
  - open **HTTPS (443)** in the instance firewall (22 and 80 are open by default);
  - turn on automatic snapshots.
- **EC2:**
  - launch Ubuntu 24.04 with a 30 GB gp3 disk;
  - allocate an **Elastic IP** and attach it;
  - in the security group allow 22 (your IP only), 80 and 443.
- **Azure:**
  - create an Ubuntu 24.04 VM (B2s, Central India) with a **static public IP**;
  - in the NSG allow 22 (your IP only), 80 and 443;
  - turn on Azure Backup for the VM if you want image backups.
- **Google Cloud:**
  - create an e2-medium VM with Ubuntu 24.04;
  - reserve a **static external IP**;
  - tick "Allow HTTP/HTTPS traffic".
- **All of them:** point the domain's A record at the static IP, SSH in, then run `setup.sh` (see DEPLOY.md).

---

## 2. WhatsApp: how we implement it

The app already talks to **Meta's WhatsApp Cloud API directly**. That covers:
- the webhook with signature checks;
- buttons, lists and location requests;
- the menu as pictures and typed orders;
- catalog carts;
- the in-chat "Review and pay" message with order status cards;
- staff chat handoff;
- review requests.

No provider (BSP) is needed in between, so there's no monthly fee.

**Steps (owner + us):**
1. **Meta Business Portfolio** (business.facebook.com) in the business's legal name, then **business verification**. Upload documents such as GST certificate, Udyam or shop licence, and a utility bill. This takes days, so **start first**.
2. **Choose the number.**
   - **Recommended:** a new SIM used only for ordering.
   - Or keep the number customers already know (e.g. Sector 15's), either with **Coexistence** (WhatsApp Business app and API on the same number, with some limits), or by moving it fully to the API.
3. At **developers.facebook.com**, create an app (type Business), add **WhatsApp**, add and verify the number, and set the **display name** to the business name (Meta reviews it; it must match signage).
4. Create a **System User** with a permanent token (permissions `whatsapp_business_messaging`, `whatsapp_business_management`). Put the token, phone number ID and app secret in `.env`.
5. **Webhook:** `https://<domain>/webhooks/whatsapp` with the verify token `setup.sh` printed; subscribe to **messages**. The server refuses to start in production if the app secret is missing.
6. **Templates** (only for messages *we* start). The `review_request` utility template asks web customers for a rating: "Hi {{1}}, how was your order {{2}}? Tap below to rate it", with a quick-reply button "Rate order". Replies to customers who messaged us need no template.
7. **Payments in the chat** (optional, best experience): in WhatsApp Manager → Payments (India), create a payment configuration connected to **Razorpay** (or PayU), and put its name on each outlet ("WhatsApp payment configuration"). Customers then pay inside WhatsApp and the payment confirms itself. Without it, the bot sends our Razorpay pay link (section 3).
8. **Test** with Meta's free test number on the staging server, then switch the token and number ID to the real number.
9. Put "Order on WhatsApp" with `https://wa.me/91XXXXXXXXXX?text=hi` and a QR code on menus, bags and the website.

**Costs (Meta's India rates, before 18% GST):**
- **Replies to customers:** free in principle. Two sources say service replies become chargeable from 1 October 2026, after 1,000 free a month per number. This wasn't confirmed on Meta's own rate card, so check it in WhatsApp Manager → Insights.
- **Utility templates** (review requests, order updates to web customers): about ₹0.115.
- **Marketing templates** (offers): about ₹0.86.

**Policy check.** Since 15 January 2026, Meta bars *general-purpose* AI chatbots from the Business API. Our bot is a task-specific ordering and customer-service bot, which Meta says is allowed. Offers go only to customers who opted in, which the bot already asks for.

**BSP (Interakt, AiSensy, Gupshup, Wati…)?** They add a monthly fee and often a per-message markup (10–30% according to several sources) for a shared inbox and campaign tools. We already have the inbox (staff Chats tab) and segments (CRM), so going **direct to Meta** is cheaper and has nothing in between.

---

## 3. Payments: capturing them properly

**Problem with plain UPI.**
- The UPI QR and `upi://` link go straight to the outlet's UPI ID. That's free, because UPI from a bank account has 0% MDR.
- But **nothing tells our server the money arrived**. Staff must check their UPI app and tap "Payment received", and customers can claim they paid when they haven't.

**What we built (release v0.22): Razorpay payment gateway.**
- **One pay link per order.** Every "Pay now" order gets one address, `https://<domain>/pay/<code>`. It's in the WhatsApp message, on the tracking page and inside the order's QR code, so paying from another phone works too.
- **Pay any way.** Opening the link creates a **Razorpay payment link** for the exact amount: any UPI app, UPI QR, cards or netbanking.
- **Self-confirming.** Razorpay's **signed webhook** marks the order paid and sends it to the kitchen, and the customer gets the confirmation on WhatsApp. Nobody has to check by hand. Repeated webhooks are ignored.
- **Safety:**
  - a wrong amount goes to staff, never marked paid;
  - a second payment for the same order is **refunded automatically**;
  - an order the outlet cancels after payment is **refunded automatically**, and the customer is told.
- **Unpaid orders** are still cancelled after 15 minutes, as before.
- **Switching it on** is three `.env` settings (see DEPLOY.md). Without them, the plain-UPI flow stays as it is.

| Option | Cost per online payment | Confirmation | Notes |
|---|---|---|---|
| Plain UPI to the outlet's UPI ID (default without keys) | Free | Staff, by hand | Money goes straight to each outlet. |
| **Razorpay payment link** (built) | Platform fee, standard 2% + GST; negotiable at volume; new-merchant offer of 0% for 90 days up to ₹5 lakh | **Automatic**, refunds automatic | Money settles to one Razorpay account (head office). |
| WhatsApp "Review and pay" connected to Razorpay/PayU | Gateway's fee | **Automatic** (WhatsApp tells us) | Best in-chat experience; uses the same Razorpay account. |
| Cashfree / PayU | Similar; Cashfree advertises 0% UPI promotions (terms vary; sources disagree) | Automatic | A small adapter like `src/razorpay.js` would add them. |

**Cost at volume.** For example, at ₹50–70 lakh a month online, with, say, 60% paid by UPI in advance, 2% would be ₹60,000–84,000 a month. **Negotiate**: large merchants routinely get UPI at 0–1%. Also keep "Pay on delivery" (no fee).

**Tested against the gateways' test systems (9 Oct 2026).** **PhonePe sandbox**, using the shared test merchant: our server created the order's dynamic UPI QR, a simulated payment was confirmed by our status check, the WhatsApp confirmation went out, and the refund went through. A failed payment left the order waiting. Run `npm run payments:sandbox` to repeat it.

| Gateway | Test system | Status |
|---|---|---|
| PhonePe | Shared test merchant | ✅ Built and passed end to end |
| Razorpay | Needs your test keys (free sign-up, test mode needs no KYC) | Built; full run needs the keys |
| PayU | Published test key works for status checks | Not built yet |
| Cashfree, Paytm, Easebuzz | Need your own sandbox sign-up | Not built yet |

**One regulatory item to watch.** A Razorpay article says a UPI MDR of 0.4% on payments above ₹2,000 (0% below) starts on 15 October 2026. We could not confirm it from NPCI or the government. Restaurant orders are mostly under ₹2,000 anyway.

**If each outlet is a separate company** and money must reach each outlet's bank account, Razorpay **Route** can split payments per outlet. That's a later addition; today all online payments settle to one account.

### Sources
- AWS Lightsail pricing: https://aws.amazon.com/lightsail/pricing/
- Azure B2s Central India: https://www.azurespeed.com/AzureVmPricing/Regions/centralindia
- DigitalOcean pricing (2026 guide): https://onedollarvps.com/pricing/digitalocean-pricing
- GCP e2 pricing (conflicting): https://cloudprice.net/gcp/compute/instances/e2-medium
- WhatsApp India rates: https://chatmaxima.com/whatsapp-api-pricing/india/ · https://whautomate.com/whatsapp-business-api-pricing-india · https://blueticks.co/blog/whatsapp-business-api-pricing-india-2026
- WhatsApp payments India (Razorpay/PayU, UPI intent): https://www.infobip.com/docs/whatsapp/whatsapp-payments/india
- General-purpose AI chatbot ban: https://techcrunch.com/2025/10/18/whatssapp-changes-its-terms-to-bar-general-purpose-chatbots-from-its-platform/
- Razorpay UPI pricing and MDR: https://razorpay.com/blog/upi-mdr-for-merchants-in-payment-gateway-explained/ · https://razorpay.com/blog/razorpay-0-percent-platform-fee-offer-90-days-new-merchants-2026/
- Razorpay payment links API: https://razorpay.com/docs/api/payments/payment-links/create-standard · webhooks: https://razorpay.com/docs/webhooks/validate-test/
- Gateway comparison (indicative): https://www.analyticsinsight.net/finance/razorpay-vs-payu-vs-cashfree-which-is-the-best-payment-gateway-for-2026

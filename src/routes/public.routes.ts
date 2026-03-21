import { Router } from "express"

const router = Router()

const APP_NAME = "HelpRide"
const SUPPORT_EMAIL = "support@help-ride.app"
const LAST_UPDATED = "March 21, 2026"

router.get(["/privacy", "/privacy-policy"], (_req, res) => {
  res.type("html").send(
    renderPage({
      title: `${APP_NAME} Privacy Policy`,
      description:
        "How HelpRide collects, uses, shares, stores, and deletes user data.",
      body: `
        <section>
          <h2>Overview</h2>
          <p>
            ${APP_NAME} is a ride-sharing platform for passengers and drivers. This policy
            explains what data we collect, why we collect it, who we share it with,
            and what choices you have.
          </p>
        </section>

        <section>
          <h2>Data We Collect</h2>
          <ul>
            <li>Account details such as name, email address, phone number, and sign-in provider.</li>
            <li>Profile details such as avatar image and driver profile information.</li>
            <li>Trip and booking details such as origin, destination, pickup, drop-off, timing, seats, pricing, and ride status.</li>
            <li>Messages exchanged between matched riders and drivers inside the app.</li>
            <li>Driver verification data such as vehicle details, license details, insurance information, and uploaded verification documents.</li>
            <li>Location data, when permission is granted, to match rides, show nearby ride requests, suggest pickup context, and improve trip safety.</li>
            <li>Device and service data such as push notification device tokens, app activity signals, and operational logs needed for reliability and fraud prevention.</li>
            <li>Payment and payout metadata such as payment intent identifiers, transaction status, amount, currency, and driver payout onboarding status.</li>
          </ul>
        </section>

        <section>
          <h2>How We Use Data</h2>
          <ul>
            <li>To create and secure user accounts.</li>
            <li>To publish rides, request rides, create bookings, and coordinate trips.</li>
            <li>To support ride-related messaging and notifications.</li>
            <li>To process payments, refunds, and driver payouts.</li>
            <li>To review driver onboarding documents and maintain trust and safety.</li>
            <li>To respond to support requests and investigate abuse, fraud, disputes, or policy violations.</li>
            <li>To comply with legal, tax, accounting, and regulatory obligations.</li>
          </ul>
        </section>

        <section>
          <h2>How We Share Data</h2>
          <ul>
            <li>Between riders and drivers when needed to complete or manage a ride.</li>
            <li>With service providers that help us run the service, including authentication, messaging, notifications, document storage, SMS, email, and payments.</li>
            <li>With payment providers such as Stripe for payment processing and payout onboarding.</li>
            <li>With communication providers such as Firebase Cloud Messaging, Pusher, Twilio, and Resend when required to deliver the service.</li>
            <li>With storage providers used to host user-uploaded documents and profile media.</li>
            <li>With law enforcement, regulators, courts, or other parties when required by law or to protect users, the platform, or the public.</li>
          </ul>
        </section>

        <section>
          <h2>Location Data</h2>
          <p>
            ${APP_NAME} requests precise or approximate location only when the user grants
            permission. The app uses location while the app is in use to help with ride
            matching, driver nearby-request discovery, pickup context, and safety-related
            trip coordination. Users can revoke location access at any time in device settings.
          </p>
        </section>

        <section>
          <h2>Payments</h2>
          <p>
            Payments are processed by Stripe and related payment providers. ${APP_NAME}
            may receive payment status, transaction identifiers, amount, currency, refund,
            and payout state needed to complete the service. ${APP_NAME} does not sell
            personal data.
          </p>
        </section>

        <section>
          <h2>Data Retention</h2>
          <p>
            We keep data only for as long as it is needed to operate the service, process
            transactions and refunds, investigate abuse or fraud, resolve disputes, and meet
            legal, tax, accounting, and regulatory obligations.
          </p>
        </section>

        <section>
          <h2>Your Choices</h2>
          <ul>
            <li>You can update profile information inside the app.</li>
            <li>You can control location and notification permissions in device settings.</li>
            <li>You can request account deletion in the app or through the account deletion page below.</li>
          </ul>
        </section>

        <section>
          <h2>Contact</h2>
          <p>
            Questions about this policy can be sent to
            <a href="mailto:${SUPPORT_EMAIL}">${SUPPORT_EMAIL}</a>.
          </p>
          <p>
            For account deletion instructions, visit
            <a href="/account-deletion">/account-deletion</a>.
          </p>
        </section>
      `,
    })
  )
})

router.get(["/account-deletion", "/delete-account"], (_req, res) => {
  res.type("html").send(
    renderPage({
      title: `${APP_NAME} Account Deletion`,
      description:
        "How HelpRide users can delete an account and what data is removed or retained.",
      body: `
        <section>
          <h2>Delete Your ${APP_NAME} Account</h2>
          <p>
            If you created a ${APP_NAME} account, you can request deletion of your account
            and associated data either inside the app or from the web.
          </p>
        </section>

        <section>
          <h2>Option 1: Delete Inside the App</h2>
          <ol>
            <li>Sign in to the ${APP_NAME} app.</li>
            <li>Open <strong>Profile</strong>.</li>
            <li>Tap <strong>Delete Account</strong>.</li>
            <li>Confirm the deletion request.</li>
          </ol>
        </section>

        <section>
          <h2>Option 2: Request Deletion From the Web</h2>
          <p>
            If you cannot access the app, email
            <a href="mailto:${SUPPORT_EMAIL}?subject=HelpRide%20account%20deletion%20request">${SUPPORT_EMAIL}</a>
            from the email address associated with your account, or include the account email
            address and phone number used in ${APP_NAME} so we can verify the request.
          </p>
        </section>

        <section>
          <h2>What Happens After Deletion</h2>
          <ul>
            <li>Your account is permanently deleted from the app.</li>
            <li>Active rides, bookings, ride requests, and open offers tied to the account are cancelled automatically.</li>
            <li>Refunds or driver payouts already in progress may continue processing after account deletion.</li>
            <li>Access tokens and session access are revoked as part of the deletion flow.</li>
          </ul>
        </section>

        <section>
          <h2>Data That May Be Retained</h2>
          <p>
            Some limited records may be retained when required for legal, tax, accounting,
            payments, fraud prevention, safety, or dispute-resolution purposes. Retained data
            is kept only as long as necessary for those obligations.
          </p>
        </section>

        <section>
          <h2>Support</h2>
          <p>
            If you have questions about deletion status or retained data, contact
            <a href="mailto:${SUPPORT_EMAIL}">${SUPPORT_EMAIL}</a>.
          </p>
          <p>
            Privacy policy:
            <a href="/privacy">/privacy</a>
          </p>
        </section>
      `,
    })
  )
})

export default router

function renderPage({
  title,
  description,
  body,
}: {
  title: string
  description: string
  body: string
}) {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${title}</title>
    <meta name="description" content="${description}" />
    <style>
      :root {
        color-scheme: light;
        --bg: #f4f7fb;
        --card: #ffffff;
        --text: #122033;
        --muted: #536273;
        --line: #d9e2ec;
        --accent: #1463ff;
      }

      * {
        box-sizing: border-box;
      }

      body {
        margin: 0;
        font-family: Arial, Helvetica, sans-serif;
        background: linear-gradient(180deg, #eef4ff 0%, var(--bg) 100%);
        color: var(--text);
      }

      main {
        max-width: 860px;
        margin: 0 auto;
        padding: 40px 20px 64px;
      }

      .card {
        background: var(--card);
        border: 1px solid var(--line);
        border-radius: 20px;
        padding: 24px;
        box-shadow: 0 10px 30px rgba(18, 32, 51, 0.08);
      }

      h1 {
        margin: 0 0 8px;
        font-size: 32px;
        line-height: 1.1;
      }

      h2 {
        margin: 0 0 10px;
        font-size: 20px;
      }

      p,
      li {
        color: var(--muted);
        font-size: 16px;
        line-height: 1.65;
      }

      section + section {
        margin-top: 24px;
        padding-top: 24px;
        border-top: 1px solid var(--line);
      }

      ul,
      ol {
        margin: 0;
        padding-left: 22px;
      }

      .eyebrow {
        display: inline-block;
        margin-bottom: 12px;
        padding: 6px 10px;
        border-radius: 999px;
        background: rgba(20, 99, 255, 0.1);
        color: var(--accent);
        font-size: 12px;
        font-weight: 700;
        letter-spacing: 0.04em;
        text-transform: uppercase;
      }

      .meta {
        margin: 0 0 28px;
        color: var(--muted);
      }

      a {
        color: var(--accent);
      }
    </style>
  </head>
  <body>
    <main>
      <div class="card">
        <div class="eyebrow">${APP_NAME}</div>
        <h1>${title}</h1>
        <p class="meta">Last updated ${LAST_UPDATED}</p>
        ${body}
      </div>
    </main>
  </body>
</html>`
}

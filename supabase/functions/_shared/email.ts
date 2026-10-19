import { EMAIL_PATTERN } from "./enquiry.ts"

export interface EnquiryRow {
  id: string
  type: string
  contact_name: string
  email: string | null
  phone: string | null
  preferred_contact: string | null
  instrument: string | null
  learner_group: string | null
  learner_name: string | null
  experience: string | null
  class_preference: string | null
  preferred_times: string | null
  message: string | null
  location_updates: boolean
  source: string
  created_at: string
}

export interface NotificationJobRow {
  id: string
  enquiry_id: string
  kind: "owner_alert" | "visitor_acknowledgement"
  recipient: string
  subject: string
  attempts: number
  processing_token: string
}

export interface EmailMessage {
  to: string
  subject: string
  html: string
  replyTo?: string
}

export function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
}

function row(label: string, value: string | null | undefined): string {
  return value ? `<p><strong>${escapeHtml(label)}:</strong> ${escapeHtml(value)}</p>` : ""
}

const BODY_STYLE = "font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; color: #111; line-height: 1.6; padding: 24px;"
const CARD_STYLE = "max-width: 600px; margin: 0 auto; border: 1px solid #e5e5e5; padding: 32px; border-radius: 4px;"
const HEADING_STYLE = "font-family: Georgia, serif; font-weight: normal; margin-top: 0; border-bottom: 2px solid #000; padding-bottom: 12px;"

export function buildNotificationEmail(job: NotificationJobRow, enquiry: EnquiryRow): EmailMessage {
  if (job.kind === "owner_alert") {
    const submitted = new Date(enquiry.created_at).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })
    const html = `<!DOCTYPE html>
<html>
  <head><meta charset="utf-8"></head>
  <body style="${BODY_STYLE}">
    <div style="${CARD_STYLE}">
      <h2 style="${HEADING_STYLE}">Mozart School — ${escapeHtml(job.subject)}</h2>
      ${row("Enquiry Type", enquiry.type)}
      ${row("Contact Name", enquiry.contact_name)}
      <p><strong>Email:</strong> ${escapeHtml(enquiry.email || "Not provided")}</p>
      <p><strong>Phone:</strong> ${escapeHtml(enquiry.phone || "Not provided")}</p>
      <p><strong>Preferred Contact:</strong> ${escapeHtml(enquiry.preferred_contact || "Either")}</p>
      ${row("Instrument", enquiry.instrument)}
      ${row("Learner Group", enquiry.learner_group)}
      ${row("Learner Name", enquiry.learner_name)}
      ${row("Experience", enquiry.experience)}
      ${row("Class Preference", enquiry.class_preference?.replace(/_/g, " "))}
      ${row("Preferred Times", enquiry.preferred_times)}
      ${enquiry.message ? `<p><strong>Message:</strong></p><blockquote style="background: #f9f9f9; padding: 12px; margin: 8px 0; border-left: 3px solid #000; white-space: pre-line;">${escapeHtml(enquiry.message)}</blockquote>` : ""}
      <p><strong>Location Updates Consent:</strong> ${enquiry.location_updates ? "Yes" : "No"}</p>
      ${row("Source", enquiry.source)}
      ${row("Submitted", submitted)}
      <hr style="border: 0; border-top: 1px solid #eee; margin: 24px 0;">
      <p style="font-size: 13px; color: #666;">Log in to the staff dashboard to reply, add notes, or manage enrolment status.</p>
    </div>
  </body>
</html>`
    const replyTo = enquiry.email && EMAIL_PATTERN.test(enquiry.email) ? enquiry.email : undefined
    return { to: job.recipient, subject: job.subject, html, replyTo }
  }

  const html = `<!DOCTYPE html>
<html>
  <head><meta charset="utf-8"></head>
  <body style="${BODY_STYLE}">
    <div style="${CARD_STYLE}">
      <h2 style="${HEADING_STYLE}">Mozart School Of Western Classical Music</h2>
      <p>Dear ${escapeHtml(enquiry.contact_name)},</p>
      <p>Thank you for reaching out to us. We have received your ${enquiry.type === "location_interest" ? "location-interest registration" : "lesson enquiry"} and will get in touch with you directly to discuss the next steps.</p>
      <div style="background: #f7f7f7; border-left: 3px solid #000; padding: 16px; margin: 20px 0;">
        <p style="margin: 0; font-weight: 500;">Online and in-person classes are available.</p>
        <p style="margin: 8px 0 0; font-style: italic; color: #444;">“Coming soon — A welcoming new space is on the way.”</p>
        <p style="margin: 6px 0 0; font-size: 13px; color: #555;">Online classes are available now. Our in-person studio is being prepared, and we will keep you informed as opening updates are confirmed.</p>
      </div>
      <p>If you have any immediate questions in the meantime, you are welcome to reach us by telephone or email:</p>
      <p style="font-size: 14px;">
        <strong>Telephone:</strong> <a href="tel:9043877104" style="color: #000;">9043877104</a><br>
        <strong>Email:</strong> <a href="mailto:srinivaschetty@gmail.com" style="color: #000;">srinivaschetty@gmail.com</a>
      </p>
      <hr style="border: 0; border-top: 1px solid #eee; margin: 24px 0;">
      <p style="font-size: 12px; color: #888; margin-bottom: 0;">Mozart School Of Western Classical Music · Chennai</p>
    </div>
  </body>
</html>`
  return { to: job.recipient, subject: job.subject, html }
}

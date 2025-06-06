import PostalMime from "postal-mime";
import {convert} from "html-to-text";

const cleanUrls = (text: string): string => {
  // Remove any remaining URLs (http/https links)
  text = text.replace(/https?:\/\/[^\s\]]+/g, "");
  // Remove empty brackets that might be left over
  text = text.replace(/\[\s*\]/g, "");
  // Clean up extra whitespace
  text = text.replace(/\n\s*\n\s*\n/g, "\n\n");
  return text;
};

// From: https://github.com/adarmanto/cloudflare-email-worker-example/blob/main/src/index.ts
const parseContent = (text?: string, html?: string): string | null => {
  // Extract body (prefer plain text, fallback to HTML conversion)
  let body = text;
  if (!body && html) {
    body = convert(html, {
      selectors: [
        {
          selector: "a",
          options: {ignoreHref: true},
        },
        {
          selector: "img",
          format: "skip", // Skip images entirely
        },
      ],
    });
  }

  if (!body) {
    return null;
  }

  return cleanUrls(body).trim();
};

const rewrite = async (email: string, env: any): Promise<string> => {
  const url = "https://openrouter.ai/api/v1/chat/completions";
  const headers = {
    Authorization: `Bearer ${env.OPENROUTER_API_KEY}`,
    "Content-Type": "application/json",
  };
  const payload = {
    model: "anthropic/claude-3.5-haiku",
    messages: [
      {
        role: "system",
        content:
          "You are an email assistant. You author well-written markdown emails based on the original email, cleaning up any extra spaces, emojis, and unnecessary details like footers, unsubscribe links, call to actions, etc. Always rewrite the email in english regardless of original language.",
      },
      {
        role: "user",
        content: `Translate this email to english if it's in a different language. Clean it up if it's English. Reply with the markdown only, no prefaces or disclaimers and no fenced code blocks. \n\n${email}`,
      },
    ],
  };

  console.log("Rewriting email...");
  const response = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
  });

  const data = (await response.json()) as any;

  if (data.choices && data.choices[0] && data.choices[0].message) {
    return data.choices[0].message.content;
  }

  throw new Error("Failed to get response from AI");
};

export default {
  async email(message, env, ctx) {
    try {
      let email;
      try {
        email = await PostalMime.parse(message.raw);
      } catch (parseError) {
        console.error("Failed to parse email:", parseError);
        message.setReject("Failed to parse email");
        return;
      }

      let body = parseContent(email.text, email.html);

      if (body && body.trim()) {
        body = await rewrite(body, env);
      } else {
        message.setReject("Failed to parse email");
        return;
      }

      // Prepare payload for the API
      const payload = JSON.stringify({
        subject: email.subject,
        name: email.from?.name,
        email: email.from?.address,
        message: body,
        source: "email",
        reply_to: message.to,
        message_id: email.messageId,
        ...(email.date && {sent_at: email.date}),
      });

      try {
        const response = await fetch(env.WEBHOOK_URL, {
          method: "POST",
          headers: {"Content-Type": "application/json"},
          body: payload,
        });

        if (!response.ok) {
          const errorText = await response.text();
          console.error(
            `Discord webhook failed: ${response.status} ${response.statusText}`,
            errorText,
          );
          message.setReject("Discord webhook failed");
          return;
        }

        console.log("Discord webhook sent successfully");
      } catch (fetchError) {
        console.error("Failed to send Discord webhook:", fetchError);
        message.setReject("Failed to send Discord webhook");
        return;
      }
    } catch (error) {
      console.error("Email handler error:", error);
      message.setReject("Failed to handle email");
      return;
    }
  },
} satisfies ExportedHandler<Env>;

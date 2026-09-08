"use client";

import { useState, type FormEvent, type ReactElement } from "react";

type Status = "idle" | "submitting" | "success" | "error";

/**
 * Client-side lead form for /book-a-demo. Not part of the supplied HTML
 * (every CTA there was a JS alert() stub, with no actual form markup to
 * port) -- built to match the same card/input/button language as the rest
 * of the site (see .demo-form in marketing.module.css) per Arif's answer:
 * a real form that saves to the DB (and optionally emails a notification),
 * not a Calendly embed or a placeholder link.
 */
export function BookDemoForm(): ReactElement {
  const [status, setStatus] = useState<Status>("idle");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const form = event.currentTarget;
    const formData = new FormData(form);
    const payload = {
      name: String(formData.get("name") || ""),
      email: String(formData.get("email") || ""),
      company: String(formData.get("company") || ""),
      message: String(formData.get("message") || ""),
    };

    setStatus("submitting");
    setErrorMessage(null);
    try {
      const response = await fetch("/api/leads/demo-request", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as { error?: string } | null;
        throw new Error(body?.error || "Something went wrong -- please try again.");
      }
      setStatus("success");
      form.reset();
    } catch (err) {
      setStatus("error");
      setErrorMessage(err instanceof Error ? err.message : "Something went wrong -- please try again.");
    }
  }

  if (status === "success") {
    return (
      <div className="card demo-form" style={{ textAlign: "center" }}>
        <h3 style={{ marginBottom: 8 }}>Thanks — we&apos;ve got it.</h3>
        <p style={{ marginBottom: 0 }}>
          Someone from AlltixOMS will reach out shortly to find a time that works for you.
        </p>
      </div>
    );
  }

  return (
    <form className="card demo-form" onSubmit={handleSubmit}>
      <div className="form-row">
        <label htmlFor="demo-name">Name</label>
        <input id="demo-name" name="name" type="text" placeholder="Jane Seller" required maxLength={200} />
      </div>
      <div className="form-row">
        <label htmlFor="demo-email">Work email</label>
        <input id="demo-email" name="email" type="email" placeholder="jane@yourbrand.com" required maxLength={320} />
      </div>
      <div className="form-row">
        <label htmlFor="demo-company">Company (optional)</label>
        <input id="demo-company" name="company" type="text" placeholder="Your Brand Inc." maxLength={200} />
      </div>
      <div className="form-row">
        <label htmlFor="demo-message">What are you looking to solve? (optional)</label>
        <textarea id="demo-message" name="message" rows={4} placeholder="Which channels do you sell on today, and what's slowing you down?" maxLength={4000} />
      </div>
      <button className="btn btn-primary" type="submit" disabled={status === "submitting"} style={{ width: "100%" }}>
        {status === "submitting" ? "Sending…" : "Book a Demo"}
      </button>
      {status === "error" && <p className="form-note error">{errorMessage}</p>}
    </form>
  );
}

import express from "express";
import OpenAI from "openai";
import { notifyArticleResponse } from "./background-article.js";

export function openaiWebhookRouter(): express.Router {
  const router = express.Router();
  router.post(
    "/hooks/openai",
    express.text({ type: "application/json", limit: "32kb" }),
    async (request, response) => {
      const secret = process.env.OPENAI_WEBHOOK_SECRET;
      if (!secret) {
        response.sendStatus(404);
        return;
      }
      try {
        const event = await new OpenAI().webhooks.unwrap(
          request.body,
          request.headers,
          secret,
        );
        if (
          event.type.startsWith("response.") &&
          "data" in event &&
          "id" in event.data &&
          typeof event.data.id === "string"
        ) {
          notifyArticleResponse(event.data.id);
        }
        response.sendStatus(204);
      } catch {
        response.sendStatus(400);
      }
    },
  );
  return router;
}

import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";

import { recordAudit } from "../lib/audit.js";
import {
  PROVIDER_NAME,
  applyAdjustment,
  fetchMarketRate,
  isPlausibleAdjustment,
  isPlausibleRate,
  isStale,
  readCurrentRate,
  recordRate,
} from "../lib/exchangeRate.js";

const manualRateBody = z.object({
  rate: z.number().positive().finite(),
});

const adjustmentBody = z.object({
  percent: z.number().finite(),
});

/** The shape every route here answers with, so the client has one thing to read. */
const currentRatePayload = (db: import("../db/client.js").Db) => {
  const reading = readCurrentRate(db);

  return {
    rate: reading.rate,
    /*
     * Both halves of the number, always. The interface shows the provider's own
     * figure beside the adjusted one, because an adjustment nobody can see is
     * indistinguishable from a feed that is simply wrong — and the next person
     * to ask "why does Lindero say 26.90 when the feed says 26.81" deserves the
     * answer on the same screen as the question.
     */
    providerRate: reading.providerRate,
    adjustmentPercent: reading.adjustmentPercent,
    source: reading.source,
    provider: reading.provider,
    capturedAt: reading.capturedAt,
    isStale: isStale(reading),
    providerName: PROVIDER_NAME,
  };
};

export const exchangeRateRoutes: FastifyPluginAsync = async (app) => {
  // Everyone signed in can READ the rate — it is on every screen that shows
  // money. Only `rate:edit` may change it.
  app.get("/exchange-rate", { onRequest: app.requireUser }, async (request, reply) =>
    reply.send(currentRatePayload(app.db)),
  );

  app.post(
    "/exchange-rate",
    { onRequest: app.requireCapability("rate:edit") },
    async (request, reply) => {
      const parsed = manualRateBody.safeParse(request.body);

      if (!parsed.success) {
        return reply.code(400).send({
          error: "invalid_body",
          message: "Enter the exchange rate in lempiras per dollar.",
        });
      }

      if (!isPlausibleRate(parsed.data.rate)) {
        return reply.code(400).send({
          error: "implausible_rate",
          message: "That rate does not look right. Enter how many lempiras one dollar costs.",
        });
      }

      const actor = request.user!;
      const previous = readCurrentRate(app.db);

      app.db.transaction((tx) => {
        recordRate(tx, {
          rate: parsed.data.rate,
          // No provider figure behind a typed rate, and the adjustment is
          // carried forward rather than applied: somebody who types 27.10 means
          // 27.10, not 27.10 plus a third of a percent. The setting survives so
          // it is still in force on the way back to automatic.
          providerRate: null,
          adjustmentPercent: previous.adjustmentPercent,
          source: "manual",
          actorId: actor.id,
        });

        recordAudit(tx, {
          actorId: actor.id,
          entityType: "exchange_rate",
          entityId: "current",
          action: "update",
          before: { rate: previous.rate, source: previous.source },
          after: { rate: parsed.data.rate, source: "manual" },
        });
      });

      return reply.send(currentRatePayload(app.db));
    },
  );

  /**
   * Hand control back to the market feed, and take a reading right away.
   *
   * Needed because a manual rate deliberately stops the scheduler from touching
   * the value — so there has to be an explicit way to say "follow the market
   * again", or an override would be permanent by accident.
   */
  app.post(
    "/exchange-rate/auto",
    { onRequest: app.requireCapability("rate:edit") },
    async (request, reply) => {
      const actor = request.user!;
      const previous = readCurrentRate(app.db);

      let providerRate: number;

      try {
        providerRate = await fetchMarketRate();
      } catch (caught) {
        // The previous rate stays in force. Nothing is written, because a
        // failed fetch is not a reading.
        return reply.code(502).send({
          error: "provider_unavailable",
          message:
            caught instanceof Error
              ? `No se pudo consultar la tasa del mercado: ${caught.message}`
              : "No se pudo consultar la tasa del mercado.",
        });
      }

      const rate = applyAdjustment(providerRate, previous.adjustmentPercent);

      app.db.transaction((tx) => {
        recordRate(tx, {
          rate,
          providerRate,
          adjustmentPercent: previous.adjustmentPercent,
          source: "auto",
          actorId: null,
        });

        recordAudit(tx, {
          actorId: actor.id,
          entityType: "exchange_rate",
          entityId: "current",
          action: "update",
          before: { rate: previous.rate, source: previous.source },
          after: { rate, providerRate, source: "auto" },
        });
      });

      return reply.send(currentRatePayload(app.db));
    },
  );

  /**
   * Set how far the displayed rate sits from the provider's figure.
   *
   * The feed publishes an indicative mid-market rate, and that is not the
   * number anybody in Honduras quotes: a bank's buy and sell sit either side of
   * it, and the figures a customer finds by searching run above it too. Asking
   * the office to explain a price tag that disagrees with the first result on
   * Google, several times a week, is a worse answer than one dial.
   *
   * It is a percentage OF the feed rather than a fixed number of lempiras, so
   * it keeps meaning the same thing as the rate moves — the gap it closes is a
   * spread, and a spread is proportional.
   *
   * Deliberately not a way to type a rate: that is what the manual override is
   * for, and it is labelled as such. This only ever nudges a figure that came
   * from the provider, the provider's own number is stored beside it, and both
   * appear on screen — so nothing here can quietly become an exchange rate
   * somebody invented.
   */
  app.post(
    "/exchange-rate/adjustment",
    { onRequest: app.requireCapability("rate:edit") },
    async (request, reply) => {
      const parsed = adjustmentBody.safeParse(request.body);

      if (!parsed.success) {
        return reply.code(400).send({
          error: "invalid_body",
          message: "Enter the adjustment as a percentage.",
        });
      }

      const { percent } = parsed.data;

      if (!isPlausibleAdjustment(percent)) {
        return reply.code(400).send({
          error: "implausible_adjustment",
          message:
            "The adjustment cannot exceed 2%. For a significantly different rate, enter it manually.",
        });
      }

      const actor = request.user!;
      const previous = readCurrentRate(app.db);

      /*
       * A manual rate is left standing.
       *
       * Somebody who has typed a rate has already said what the number is, and
       * silently replacing it with a feed reading because they touched a
       * different setting would be the override failing exactly when it was
       * asked to hold. The new percentage is stored and takes effect the moment
       * they hand control back to the market.
       */
      if (previous.source === "manual") {
        app.db.transaction((tx) => {
          recordRate(tx, {
            rate: previous.rate,
            providerRate: null,
            adjustmentPercent: percent,
            source: "manual",
            actorId: actor.id,
          });

          recordAudit(tx, {
            actorId: actor.id,
            entityType: "exchange_rate",
            entityId: "current",
            action: "update",
            before: { adjustmentPercent: previous.adjustmentPercent, source: "manual" },
            after: { adjustmentPercent: percent, source: "manual" },
          });
        });

        return reply.send(currentRatePayload(app.db));
      }

      /*
       * Re-derived from the figure already on file where there is one, so the
       * effect of a change is visible immediately and without a network round
       * trip — which is what makes this dial-able against a second window.
       * Rows written before this column existed have none, so those ask the
       * provider once.
       */
      let providerRate = previous.providerRate;

      if (providerRate === null) {
        try {
          providerRate = await fetchMarketRate();
        } catch (caught) {
          return reply.code(502).send({
            error: "provider_unavailable",
            message:
              caught instanceof Error
                ? `No se pudo consultar la tasa del mercado: ${caught.message}`
                : "No se pudo consultar la tasa del mercado.",
          });
        }
      }

      const rate = applyAdjustment(providerRate, percent);

      app.db.transaction((tx) => {
        recordRate(tx, {
          rate,
          providerRate,
          adjustmentPercent: percent,
          source: "auto",
          actorId: actor.id,
        });

        recordAudit(tx, {
          actorId: actor.id,
          entityType: "exchange_rate",
          entityId: "current",
          action: "update",
          before: { rate: previous.rate, adjustmentPercent: previous.adjustmentPercent },
          after: { rate, providerRate, adjustmentPercent: percent },
        });
      });

      return reply.send(currentRatePayload(app.db));
    },
  );
};

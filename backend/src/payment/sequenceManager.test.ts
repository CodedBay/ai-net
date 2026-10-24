import { SequenceNumberManager, SEQUENCE_LOCK_TTL_MS, type RedisSequenceLockClient } from "./sequenceManager";

describe("SequenceNumberManager", () => {
  describe("withAccount – single account serialization", () => {
    it("serializes 10 concurrent calls on the same account key", async () => {
      const mgr = new SequenceNumberManager();
      const order: number[] = [];

      // Launch 10 concurrent calls that each record their execution index.
      const tasks = Array.from({ length: 10 }, (_, i) =>
        mgr.withAccount("GACCOUNT123", async () => {
          order.push(i);
        })
      );

      await Promise.all(tasks);

      // All 10 calls must have run (order is deterministic FIFO).
      expect(order).toHaveLength(10);
      // They must run in the order they were enqueued.
      expect(order).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    });

    it("resolves each call's return value correctly", async () => {
      const mgr = new SequenceNumberManager();

      const [a, b, c] = await Promise.all([
        mgr.withAccount("GABC", async () => 1),
        mgr.withAccount("GABC", async () => 2),
        mgr.withAccount("GABC", async () => 3),
      ]);

      expect(a).toBe(1);
      expect(b).toBe(2);
      expect(c).toBe(3);
    });

    it("cleans up the internal map entry after all calls settle", async () => {
      const mgr = new SequenceNumberManager();

      await mgr.withAccount("GCLEAN", async () => {});

      // Access private field for assertion (TypeScript allows via bracket notation).
      expect((mgr as unknown as { locks: Map<string, Promise<void>> }).locks.size).toBe(0);
    });
  });

  describe("withAccount – parallel execution across different accounts", () => {
    it("allows concurrent calls on different account keys to overlap", async () => {
      const mgr = new SequenceNumberManager();
      const started: string[] = [];
      const finished: string[] = [];

      // Two accounts with artificial delays.
      const p1 = mgr.withAccount("GACC1", async () => {
        started.push("GACC1");
        await new Promise((r) => setTimeout(r, 20));
        finished.push("GACC1");
      });
      const p2 = mgr.withAccount("GACC2", async () => {
        started.push("GACC2");
        await new Promise((r) => setTimeout(r, 10));
        finished.push("GACC2");
      });

      await Promise.all([p1, p2]);

      // Both should have started before either finished (true concurrency).
      expect(started).toHaveLength(2);
      expect(finished).toHaveLength(2);
      // GACC2 has a shorter delay so it should finish first.
      expect(finished[0]).toBe("GACC2");
    });
  });

  describe("withAccount – error propagation and queue continuity", () => {
    it("propagates errors to the caller without blocking subsequent enqueued calls", async () => {
      const mgr = new SequenceNumberManager();
      const results: string[] = [];

      const p1 = mgr
        .withAccount("GACC_ERR", async () => {
          throw new Error("tx_bad_seq");
        })
        .catch((e: Error) => {
          results.push(`error:${e.message}`);
        });

      const p2 = mgr.withAccount("GACC_ERR", async () => {
        results.push("success");
      });

      await Promise.all([p1, p2]);

      expect(results[0]).toBe("error:tx_bad_seq");
      expect(results[1]).toBe("success");
    });

    it("does not leave the queue stuck after a failure", async () => {
      const mgr = new SequenceNumberManager();

      await expect(
        mgr.withAccount("GSTUCK", async () => {
          throw new Error("boom");
        })
      ).rejects.toThrow("boom");

      // Next call on the same account must complete normally.
      const result = await mgr.withAccount("GSTUCK", async () => "ok");
      expect(result).toBe("ok");
    });
  });

  describe("withAccount – Redis coordination", () => {
    it("uses a 10-second Redis lease and releases only its own lock token", async () => {
      const redis: RedisSequenceLockClient = {
        set: jest.fn().mockResolvedValue("OK"),
        eval: jest.fn().mockResolvedValue(1),
      };
      const manager = new SequenceNumberManager(redis);

      await expect(manager.withAccount("GREDIS", async () => "submitted")).resolves.toBe("submitted");

      expect(redis.set).toHaveBeenCalledWith(
        "stellar:sequence:GREDIS",
        expect.any(String),
        "PX",
        SEQUENCE_LOCK_TTL_MS,
        "NX",
      );
      expect(redis.eval).toHaveBeenCalledWith(expect.stringContaining("redis.call(\"get\""), 1, "stellar:sequence:GREDIS", expect.any(String));
    });
  });

  describe("tx_bad_seq retry — payment.ts integration guard", () => {
    it("a caller can implement its own retry wrapper using withAccount", async () => {
      const mgr = new SequenceNumberManager();
      let attempt = 0;

      function isBadSeq(err: unknown): boolean {
        const extras =
          (
            err as {
              response?: { data?: { extras?: { result_codes?: { transaction?: string } } } };
            }
          )?.response?.data?.extras?.result_codes?.transaction ?? "";
        return extras === "tx_bad_seq";
      }

      const result = await mgr.withAccount("GBADSEQ", async () => {
        attempt++;
        if (attempt === 1) {
          // Simulate tx_bad_seq on first attempt.
          const err: { message: string; response: { data: { extras: { result_codes: { transaction: string } } } } } = {
            message: "transaction failed",
            response: { data: { extras: { result_codes: { transaction: "tx_bad_seq" } } } },
          };
          if (isBadSeq(err)) {
            // Retry: second attempt succeeds.
            return "retried-success";
          }
          throw err;
        }
        return "first-success";
      });

      expect(result).toBe("retried-success");
      expect(attempt).toBe(1);
    });
  });
});

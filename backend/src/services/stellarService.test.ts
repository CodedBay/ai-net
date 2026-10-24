jest.mock("@stellar/stellar-sdk", () => {
  let transactionIndex = 0;
  class MockTransactionBuilder {
    addOperation() { return this; }
    addMemo() { return this; }
    setTimeout() { return this; }
    build() {
      const xdr = `xdr-${++transactionIndex}`;
      return { sign: jest.fn(), toXDR: () => xdr, getClaimableBalanceId: () => "balance-id" };
    }
    static fromXDR(xdr: string) {
      return { xdr };
    }
  }
  return {
    BASE_FEE: "100",
    Horizon: { Server: jest.fn() },
    TransactionBuilder: MockTransactionBuilder,
    Operation: { payment: jest.fn((operation) => operation) },
    Asset: { native: jest.fn(() => ({ code: "XLM" })) },
    Memo: { text: jest.fn((text) => ({ text })) },
  };
});

import { StellarService, StellarServiceError } from "./stellarService";

describe("StellarService", () => {
  const keypair = { publicKey: () => "GTEST", sign: jest.fn() } as any;
  let server: {
    loadAccount: jest.Mock;
    submitTransaction: jest.Mock;
    getTransaction: jest.Mock;
  };

  beforeEach(() => {
    server = {
      loadAccount: jest.fn().mockResolvedValue({ sequence: "1" }),
      submitTransaction: jest.fn().mockResolvedValue({ hash: "tx-hash" }),
      getTransaction: jest.fn(),
    };
  });

  it("builds and submits a payment transaction", async () => {
    const service = new StellarService({ server: server as any, networkPassphrase: "test" });
    const transaction = await service.buildPaymentTransaction(keypair, "GDEST", 1.25, "memo");
    const result = await service.submitTransaction(transaction.toXDR());

    expect(result).toEqual({ hash: "tx-hash", success: true });
    expect(server.loadAccount).toHaveBeenCalledWith("GTEST");
    expect(server.submitTransaction).toHaveBeenCalledTimes(1);
  });

  it("rebuilds with a fresh account after sequence conflicts, up to three retries", async () => {
    const conflict = Object.assign(new Error("bad sequence"), {
      response: { data: { extras: { result_codes: { transaction: "tx_bad_seq" } } } },
    });
    server.submitTransaction
      .mockRejectedValueOnce(conflict)
      .mockRejectedValueOnce(conflict)
      .mockRejectedValueOnce(conflict)
      .mockResolvedValueOnce({ hash: "retried-hash" });
    const service = new StellarService({ server: server as any, networkPassphrase: "test" });
    const transaction = await service.buildPaymentTransaction(keypair, "GDEST", 2);

    await expect(service.submitTransaction(transaction.toXDR())).resolves.toEqual({
      hash: "retried-hash",
      success: true,
    });
    expect(server.submitTransaction).toHaveBeenCalledTimes(4);
    expect(server.loadAccount).toHaveBeenCalledTimes(4);
  });

  it("returns the native account balance", async () => {
    server.loadAccount.mockResolvedValue({
      sequence: "1",
      balances: [{ asset_type: "native", balance: "12.5" }],
    });
    const service = new StellarService({ server: server as any });

    await expect(service.getAccountBalance("GTEST")).resolves.toBe(12.5);
  });

  it("waits until a transaction is available", async () => {
    const notFound = Object.assign(new Error("not found"), { response: { status: 404 } });
    server.getTransaction
      .mockReturnValueOnce({ call: jest.fn().mockRejectedValue(notFound) })
      .mockReturnValueOnce({ call: jest.fn().mockResolvedValue({ hash: "tx-hash", successful: true }) });
    const service = new StellarService({ server: server as any, pollIntervalMs: 0 });

    await expect(service.waitForTransaction("tx-hash", 100)).resolves.toMatchObject({
      hash: "tx-hash",
      successful: true,
    });
  });

  it("maps Horizon failures to descriptive application errors", async () => {
    server.loadAccount.mockRejectedValue(Object.assign(new Error("missing"), { response: { status: 404 } }));
    const service = new StellarService({ server: server as any });

    await expect(service.getAccountBalance("GMISSING")).rejects.toMatchObject<Partial<StellarServiceError>>({
      code: "STELLAR_NOT_FOUND",
      statusCode: 404,
      message: "Stellar account or transaction was not found",
    });
  });
});

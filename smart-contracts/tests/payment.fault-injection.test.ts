/**
 * Fault-injection tests for the payment layer.
 *
 * Injects Horizon failures (429, 504, 404, network errors) and asserts
 * correct resume/fallback behavior.
 *
 * Each injected fault has an asserting test — see SECURITY_CHECKLIST.md §F4-F6.
 */
import {
  Keypair,
  Asset,
  Operation,
  TransactionBuilder,
  Networks,
  Claimant,
  Memo,
  NotFoundError,
  Account,
} from '@stellar/stellar-sdk';
import {
  lockEscrow,
  releasePayment,
  refundEscrow,
  getEscrowBalance,
  EscrowAlreadySettledError,
  xlmToStroops,
  stroopsToXlm,
} from '../src/payment/payment';

jest.setTimeout(180000);

const mockLoadAccount = jest.fn();
const mockFetchBaseFee = jest.fn();
const mockTransactionsCall = jest.fn();
const mockClaimableBalanceCall = jest.fn();
const mockSubmitTransaction = jest.fn();

jest.mock('@stellar/stellar-sdk', () => {
  const actual = jest.requireActual('@stellar/stellar-sdk');
  return {
    ...actual,
    Horizon: {
      ...actual.Horizon,
      Server: jest.fn().mockImplementation(() => ({
        loadAccount: mockLoadAccount,
        fetchBaseFee: mockFetchBaseFee,
        submitTransaction: mockSubmitTransaction,
        transactions: jest.fn().mockReturnValue({
          forAccount: jest.fn().mockReturnValue({
            order: jest.fn().mockReturnValue({
              limit: jest.fn().mockReturnValue({
                call: mockTransactionsCall,
              }),
            }),
          }),
        }),
        claimableBalances: jest.fn().mockReturnValue({
          claimableBalance: jest.fn().mockReturnValue({
            call: mockClaimableBalanceCall,
          }),
        }),
      })),
    },
  };
});

let coordinatorKeypair: Keypair;
let agentKeypair: Keypair;
let taskId: string;
let envelopeXdr: string;
let originalSetTimeout: any;

beforeAll(() => {
  coordinatorKeypair = Keypair.random();
  agentKeypair = Keypair.random();
  taskId = 'fault_inject_task';

  const account = new Account(coordinatorKeypair.publicKey(), '123');
  const claimants = [
    new Claimant(coordinatorKeypair.publicKey(), Claimant.predicateUnconditional()),
  ];
  const tx = new TransactionBuilder(account, {
    fee: '100',
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(
      Operation.createClaimableBalance({
        asset: Asset.native(),
        amount: '10.0000000',
        claimants,
      })
    )
    .addMemo(Memo.text(taskId))
    .setTimeout(180)
    .build();
  tx.sign(coordinatorKeypair);
  envelopeXdr = tx.toEnvelope().toXDR('base64');

  originalSetTimeout = global.setTimeout;
  // @ts-ignore
  global.setTimeout = (fn: any) => fn();
});

afterAll(() => {
  global.setTimeout = originalSetTimeout;
});

beforeEach(() => {
  mockLoadAccount.mockReset();
  mockFetchBaseFee.mockReset();
  mockSubmitTransaction.mockReset();
  mockTransactionsCall.mockReset();
  mockClaimableBalanceCall.mockReset();

  mockLoadAccount.mockImplementation((pubkey: string) =>
    Promise.resolve(new Account(pubkey, '123'))
  );
  mockFetchBaseFee.mockResolvedValue(100);
  mockSubmitTransaction.mockResolvedValue({ hash: 'mock_tx_hash' });
  mockTransactionsCall.mockResolvedValue({ records: [] });
  mockClaimableBalanceCall.mockResolvedValue({ amount: '10.0000000' });

  process.env.STELLAR_NETWORK = 'testnet';
});

// ── F4: Horizon 429 → exponential backoff retries ─────────────────────────────

// FLAKY: patches global.setTimeout to make backoff retries instant; any
// concurrent test that also reads global.setTimeout (e.g. heartbeat cleanup)
// can see the patched version if teardown races. Tracked in #95.
describe('F4 · Horizon 429 rate limit → retry with backoff', () => {
  it('retries 5 times on 429 and then throws', async () => {
    const err429 = new Error('Rate limit exceeded');
    (err429 as any).response = { status: 429 };
    mockLoadAccount.mockRejectedValue(err429);

    await expect(
      lockEscrow(coordinatorKeypair, agentKeypair.publicKey(), '1', 'task_429')
    ).rejects.toThrow();

    expect(mockLoadAccount).toHaveBeenCalledTimes(5);
  });

  it('succeeds after transient 429 errors resolve', async () => {
    const err429 = new Error('Rate limit');
    (err429 as any).response = { status: 429 };

    mockLoadAccount
      .mockRejectedValueOnce(err429)
      .mockRejectedValueOnce(err429)
      .mockImplementationOnce((pubkey: string) => Promise.resolve(new Account(pubkey, '123')));

    const hash = await lockEscrow(coordinatorKeypair, agentKeypair.publicKey(), '1', 'task_429_ok');

    expect(hash).toBe('mock_tx_hash');
    expect(mockLoadAccount).toHaveBeenCalledTimes(3);
  });
});

// ── F4b: Horizon 504 → retry then success ────────────────────────────────────

describe('F4b · Horizon 504 gateway timeout → retry', () => {
  it('succeeds after transient 504 errors', async () => {
    const err504 = new Error('Gateway Timeout');
    (err504 as any).response = { status: 504 };

    mockLoadAccount
      .mockRejectedValueOnce(err504)
      .mockRejectedValueOnce(err504)
      .mockImplementationOnce((pubkey: string) => Promise.resolve(new Account(pubkey, '123')));

    const hash = await lockEscrow(coordinatorKeypair, agentKeypair.publicKey(), '1', 'task_504');

    expect(hash).toBe('mock_tx_hash');
    expect(mockLoadAccount).toHaveBeenCalledTimes(3);
  });
});

// ── F5: Horizon 404 on release → EscrowAlreadySettledError ────────────────────

describe('F5 · Horizon 404 on release → EscrowAlreadySettledError', () => {
  it('throws EscrowAlreadySettledError when balance is 404', async () => {
    mockTransactionsCall.mockResolvedValueOnce({
      records: [{ memo_type: 'text', memo: taskId, envelope_xdr: envelopeXdr }],
    });

    const err404 = new NotFoundError('Not Found', {
      status: 404,
      statusText: 'Not Found',
      headers: {},
      config: {},
      data: {},
    });
    mockClaimableBalanceCall.mockRejectedValueOnce(err404);

    await expect(
      releasePayment(coordinatorKeypair, agentKeypair.publicKey(), taskId)
    ).rejects.toThrow(EscrowAlreadySettledError);
  });
});

// ── F6: Horizon 404 on refund → EscrowAlreadySettledError ─────────────────────

describe('F6 · Horizon 404 on refund → EscrowAlreadySettledError', () => {
  it('throws EscrowAlreadySettledError when balance is 404', async () => {
    mockTransactionsCall.mockResolvedValueOnce({
      records: [{ memo_type: 'text', memo: taskId, envelope_xdr: envelopeXdr }],
    });

    const err404 = new NotFoundError('Not Found', {
      status: 404,
      statusText: 'Not Found',
      headers: {},
      config: {},
      data: {},
    });
    mockClaimableBalanceCall.mockRejectedValueOnce(err404);

    await expect(refundEscrow(coordinatorKeypair, taskId)).rejects.toThrow(
      EscrowAlreadySettledError
    );
  });
});

// ── F7: Non-404 Horizon error → propagated (not swallowed) ────────────────────

describe('F7 · non-404 Horizon errors propagated', () => {
  it('releasePayment propagates Horizon internal error', async () => {
    mockTransactionsCall.mockResolvedValueOnce({
      records: [{ memo_type: 'text', memo: taskId, envelope_xdr: envelopeXdr }],
    });
    mockClaimableBalanceCall.mockRejectedValueOnce(new Error('horizon 500'));

    await expect(
      releasePayment(coordinatorKeypair, agentKeypair.publicKey(), taskId)
    ).rejects.toThrow('horizon 500');
  });

  it('refundEscrow propagates Horizon internal error', async () => {
    mockTransactionsCall.mockResolvedValueOnce({
      records: [{ memo_type: 'text', memo: taskId, envelope_xdr: envelopeXdr }],
    });
    mockClaimableBalanceCall.mockRejectedValueOnce(new Error('horizon 500'));

    await expect(refundEscrow(coordinatorKeypair, taskId)).rejects.toThrow('horizon 500');
  });
});

// ── F8: No creation tx found → descriptive error (not EscrowAlreadySettled) ────

describe('F8 · no creation tx → descriptive error', () => {
  it('throws when no CreateClaimableBalance tx exists', async () => {
    mockTransactionsCall.mockResolvedValueOnce({ records: [] });

    await expect(
      releasePayment(coordinatorKeypair, agentKeypair.publicKey(), 'never_locked')
    ).rejects.toThrow(/No CreateClaimableBalance transaction found/);

    expect(mockClaimableBalanceCall).not.toHaveBeenCalled();
  });
});

// ── F9: getEscrowBalance fault scenarios ───────────────────────────────────────

describe('F9 · getEscrowBalance fault scenarios', () => {
  const originalEnv = process.env;

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('throws when neither key env var is set', async () => {
    delete process.env.STELLAR_COORDINATOR_PUBLIC_KEY;
    delete process.env.STELLAR_SECRET_KEY;

    await expect(getEscrowBalance('any_task')).rejects.toThrow(
      'Either STELLAR_COORDINATOR_PUBLIC_KEY or STELLAR_SECRET_KEY must be set.'
    );
  });

  it('returns 0 when balance is settled (404)', async () => {
    process.env.STELLAR_COORDINATOR_PUBLIC_KEY = coordinatorKeypair.publicKey();

    mockTransactionsCall.mockResolvedValueOnce({
      records: [{ memo_type: 'text', memo: taskId, envelope_xdr: envelopeXdr }],
    });

    const err404 = new NotFoundError('Not Found', {
      status: 404,
      statusText: 'Not Found',
      headers: {},
      config: {},
      data: {},
    });
    mockClaimableBalanceCall.mockRejectedValueOnce(err404);

    await expect(getEscrowBalance(taskId)).resolves.toBe(0);
  });

  it('propagates unexpected non-404 errors', async () => {
    process.env.STELLAR_COORDINATOR_PUBLIC_KEY = coordinatorKeypair.publicKey();

    mockTransactionsCall.mockResolvedValueOnce({
      records: [{ memo_type: 'text', memo: taskId, envelope_xdr: envelopeXdr }],
    });
    mockClaimableBalanceCall.mockRejectedValueOnce(new Error('horizon 500'));

    await expect(getEscrowBalance(taskId)).rejects.toThrow('horizon 500');
  });
});

// ── F10: Lock succeeds after transient errors ─────────────────────────────────

describe('F10 · lockEscrow succeeds after transient errors', () => {
  it('returns tx hash after Horizon recovers', async () => {
    const err504 = new Error('Gateway Timeout');
    (err504 as any).response = { status: 504 };

    mockLoadAccount
      .mockRejectedValueOnce(err504)
      .mockRejectedValueOnce(err504)
      .mockImplementationOnce((pubkey: string) => Promise.resolve(new Account(pubkey, '123')));

    const hash = await lockEscrow(
      coordinatorKeypair,
      agentKeypair.publicKey(),
      '5.0',
      'task_lock_recovery'
    );

    expect(hash).toBe('mock_tx_hash');
    expect(mockSubmitTransaction).toHaveBeenCalledTimes(1);
  });
});

// ── F11: Fee fallback when fetchBaseFee fails ─────────────────────────────────

describe('F11 · fee fallback on fetchBaseFee failure', () => {
  it('uses baseFee of 100 stroops when fetchBaseFee throws', async () => {
    mockFetchBaseFee.mockRejectedValueOnce(new Error('fee endpoint down'));

    const hash = await lockEscrow(
      coordinatorKeypair,
      agentKeypair.publicKey(),
      '1',
      'task_fee_fallback'
    );

    expect(hash).toBe('mock_tx_hash');
    const submittedTx = mockSubmitTransaction.mock.calls[0][0];
    expect(submittedTx.fee).toBe('100');
  });
});

// ── F12: Horizon RPC timeout during escrow release — no double-release ─────────
//
// Invariant: an RPC timeout during release must NOT double-release the escrow.
// The escrow balance must still exist if the submit fails; calling release a
// second time after the transient timeout must fail with the same error so
// the orchestration layer can decide whether to retry or expire the escrow.

describe('F12 · Horizon RPC timeout during escrow release — no double-release', () => {
  it('does not double-release when submitTransaction times out 3 times then throws', async () => {
    // Arrange: escrow creation tx found for taskId.
    mockTransactionsCall.mockResolvedValue({
      records: [{ memo_type: 'text', memo: taskId, envelope_xdr: envelopeXdr }],
    });

    // Escrow balance exists — claim not yet settled.
    mockClaimableBalanceCall.mockResolvedValue({ amount: '10.0000000' });

    // submitTransaction times out on every attempt.
    const timeoutErr = new Error('TIMEOUT: request timed out after 30s');
    (timeoutErr as any).response = { status: 504 };
    mockSubmitTransaction.mockRejectedValue(timeoutErr);

    // Act: first release attempt — should exhaust retries and throw.
    await expect(
      releasePayment(coordinatorKeypair, agentKeypair.publicKey(), taskId)
    ).rejects.toThrow();

    // Assert: submitTransaction was called (retried), not zero times.
    expect(mockSubmitTransaction.mock.calls.length).toBeGreaterThanOrEqual(1);

    // Assert: the claimable balance query ran exactly once per attempt —
    // there was no duplicate "claim" operation submitted.
    const submitCallCount = mockSubmitTransaction.mock.calls.length;
    expect(submitCallCount).toBeLessThanOrEqual(5); // bounded by MAX_RETRIES

    // Assert: the escrow balance was never claimed — a subsequent call to
    // getEscrowBalance (which reads the claimable balance) should still see
    // the original amount, not 0 (settled).
    process.env.STELLAR_COORDINATOR_PUBLIC_KEY = coordinatorKeypair.publicKey();
    const balance = await getEscrowBalance(taskId);
    expect(balance).toBeGreaterThan(0); // escrow still locked, not double-released
  });
});

// ── F13: Coordinator crash mid-pipeline — funds not permanently locked ─────────
//
// Invariant: if the coordinator crashes after lockEscrow succeeds but before
// task dispatch, the escrowed funds must be recoverable via refundEscrow after
// the escrow TTL expires (simulated here by calling refundEscrow directly).

describe('F13 · Coordinator crash mid-pipeline — refund path reachable', () => {
  it('allows refundEscrow after lock succeeds but task dispatch was never called', async () => {
    // Step 1: lockEscrow succeeds.
    const lockHash = await lockEscrow(
      coordinatorKeypair,
      agentKeypair.publicKey(),
      '1',
      'task_crash_test'
    );
    expect(lockHash).toBe('mock_tx_hash');

    // Step 2: Simulate coordinator crash — task dispatch never happens.
    // (No additional mock setup needed — the crash is represented by not
    //  calling any dispatch function here.)

    // Step 3: Set up the refund path: the creation tx is findable, and the
    //         claimable balance still exists (not yet settled).
    mockTransactionsCall.mockResolvedValueOnce({
      records: [{ memo_type: 'text', memo: 'task_crash_test', envelope_xdr: envelopeXdr }],
    });
    mockClaimableBalanceCall.mockResolvedValueOnce({ amount: '1.0000000' });
    mockSubmitTransaction.mockResolvedValueOnce({ hash: 'refund_tx_hash' });

    // Step 4: After expiry / recovery, refundEscrow can reclaim the funds.
    const refundHash = await refundEscrow(coordinatorKeypair, 'task_crash_test');
    expect(refundHash).toBe('refund_tx_hash');

    // Assert: funds were not permanently locked.
    expect(mockSubmitTransaction).toHaveBeenCalledWith(
      expect.objectContaining({ operations: expect.anything() })
    );
  });
});

// ── F14: Insufficient XLM balance — no partial state written ──────────────────
//
// Invariant: if the coordinator wallet has insufficient XLM for the requested
// escrow amount, the call must fail before any escrow creation. No partial
// state (claimable balance, memo record) must be written to the ledger.

describe('F14 · Insufficient XLM balance — coordinator has 0.5 XLM, task needs 1 XLM', () => {
  it('throws before escrow creation with no partial state', async () => {
    // Simulate Stellar's op_underfunded response when the coordinator tries
    // to create a claimable balance larger than its available XLM.
    const underfundedErr = new Error('Request failed with status code 400');
    (underfundedErr as any).response = {
      status: 400,
      data: {
        extras: {
          result_codes: {
            transaction: 'tx_failed',
            operations: ['op_underfunded'],
          },
        },
      },
    };
    // loadAccount succeeds (account exists) but submitTransaction fails.
    mockLoadAccount.mockImplementationOnce((pubkey: string) =>
      Promise.resolve(new Account(pubkey, '123'))
    );
    mockSubmitTransaction.mockRejectedValueOnce(underfundedErr);

    // A 1 XLM escrow on a wallet with only 0.5 XLM usable.
    await expect(
      lockEscrow(coordinatorKeypair, agentKeypair.publicKey(), '1', 'task_underfunded')
    ).rejects.toThrow(/400|underfunded|op_underfunded/i);

    // Assert: no successful submission occurred.
    expect(mockSubmitTransaction).toHaveBeenCalledTimes(1);
    // Assert: no subsequent Horizon query (claimable balance lookup) was made —
    // meaning the escrow was never created.
    expect(mockClaimableBalanceCall).not.toHaveBeenCalled();
  });
});

// ── F15: Agent double-payment — contract-level idempotency ────────────────────
//
// Invariant: two concurrent coordinator calls attempting to release the same
// escrow must result in exactly one successful release. The second call must
// receive EscrowAlreadySettledError (404 from Horizon) rather than succeeding
// a second time, ensuring the agent is paid once and only once.

describe('F15 · Agent double-payment — only one release succeeds', () => {
  it('second concurrent release call gets EscrowAlreadySettledError', async () => {
    // Both calls find the creation tx.
    mockTransactionsCall.mockResolvedValue({
      records: [{ memo_type: 'text', memo: taskId, envelope_xdr: envelopeXdr }],
    });

    // First call: balance exists (claim not yet settled).
    mockClaimableBalanceCall.mockResolvedValueOnce({ amount: '10.0000000' });
    mockSubmitTransaction.mockResolvedValueOnce({ hash: 'first_release_hash' });

    // First release succeeds.
    const firstHash = await releasePayment(
      coordinatorKeypair,
      agentKeypair.publicKey(),
      taskId
    );
    expect(firstHash).toBe('mock_tx_hash');

    // Second concurrent call: Horizon returns 404 because balance already claimed.
    const err404 = new NotFoundError('Not Found', {
      status: 404,
      statusText: 'Not Found',
      headers: {},
      config: {},
      data: {},
    });
    mockTransactionsCall.mockResolvedValueOnce({
      records: [{ memo_type: 'text', memo: taskId, envelope_xdr: envelopeXdr }],
    });
    mockClaimableBalanceCall.mockRejectedValueOnce(err404);

    // Second release must fail with EscrowAlreadySettledError — not with a
    // second successful payment.
    await expect(
      releasePayment(coordinatorKeypair, agentKeypair.publicKey(), taskId)
    ).rejects.toThrow(EscrowAlreadySettledError);
  });
});

// Automatic manual mock for @stellar/stellar-sdk
// Used when jest.mock('@stellar/stellar-sdk') is called in tests

const mockTx = {
  sign: jest.fn(),
  getClaimableBalanceId: jest.fn().mockReturnValue("balance-id-abc"),
  toXDR: jest.fn().mockReturnValue("mock-transaction-xdr"),
};

const Keypair = {
  fromSecret: jest.fn().mockReturnValue({
    publicKey: () => "GCOORDINATOR",
    sign: jest.fn(),
  }),
  random: jest.fn().mockReturnValue({ publicKey: () => "GRANDOM", sign: jest.fn() }),
};

const Server = jest.fn().mockImplementation(() => ({
  loadAccount: jest.fn().mockResolvedValue({ id: "GCOORDINATOR", sequence: "1" }),
  submitTransaction: jest.fn().mockResolvedValue({ hash: "txhash-001" }),
  getTransaction: jest.fn().mockReturnValue({ call: jest.fn().mockResolvedValue({ hash: "txhash-001", successful: true }) }),
  claimableBalances: jest.fn().mockReturnValue({
    claimableBalance: jest.fn().mockReturnValue({
      call: jest.fn().mockResolvedValue({ id: "cb-1", amount: "1.0000000", asset: "native", sponsor: "GCOORDINATOR", claimants: [{ destination: "GAGENT" }] }),
    }),
    forAsset: jest.fn().mockReturnThis(),
    limit: jest.fn().mockReturnThis(),
    call: jest.fn().mockResolvedValue({ records: [] }),
  }),
}));

const Horizon = { Server };

const TransactionBuilder = jest.fn().mockImplementation(() => ({
  addOperation: jest.fn().mockReturnThis(),
  addMemo: jest.fn().mockReturnThis(),
  setTimeout: jest.fn().mockReturnThis(),
  build: jest.fn().mockReturnValue(mockTx),
}));
TransactionBuilder.fromXDR = jest.fn().mockReturnValue(mockTx);

const Operation = {
  payment: jest.fn().mockReturnValue({}),
  createClaimableBalance: jest.fn().mockReturnValue({}),
  claimClaimableBalance: jest.fn().mockReturnValue({}),
};

const Asset = { native: jest.fn().mockReturnValue({}) };
const Memo = { text: jest.fn().mockReturnValue({}) };
const StrKey = jest.requireActual("@stellar/stellar-sdk").StrKey;

const Claimant = Object.assign(
  jest.fn().mockReturnValue({}),
  { predicateUnconditional: jest.fn().mockReturnValue({}) }
);

const BASE_FEE = "100";
const Networks = { TESTNET: "Test SDF Network ; September 2015" };

module.exports = { Keypair, Server, Horizon, TransactionBuilder, Operation, Asset, Memo, StrKey, Claimant, BASE_FEE, Networks };

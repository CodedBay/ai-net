export const isBrowser = true

export async function isConnected() {
  return { isConnected: true }
}

export async function isAllowed() {
  return { isAllowed: false }
}

export async function requestAccess() {
  return { address: 'GDEUVS2EDX2ENN2RYHFIWJXT6XHXMOXI7EUKMU2YDF637JLJAOX4UT3J' }
}

export async function signTransaction(transactionXdr: string) {
  return { signedTxXdr: transactionXdr }
}
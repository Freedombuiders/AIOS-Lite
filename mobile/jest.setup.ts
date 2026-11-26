// Nothing in the tests may reach the network or the keychain: the cloud client takes an injected
// fetch, and storage is injected too. Fail loudly if a test forgets.
const noNetwork = () => { throw new Error('network access in a test: inject a fetch'); };
(globalThis as { fetch: unknown }).fetch = noNetwork;

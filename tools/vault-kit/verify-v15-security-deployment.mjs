#!/usr/bin/env node
import { Contract, JsonRpcProvider, getAddress } from "ethers";

const required = (name) => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
};
const same = (left, right) => getAddress(left) === getAddress(right);
const expect = (condition, message) => {
  if (!condition) throw new Error(message);
};

const provider = new JsonRpcProvider(required("YOMINET_RPC"));
const expected = {
  musuMarket: required("MUSU_MARKET"),
  vippMarket: required("VIPP_MARKET"),
  musuFactory: required("MUSU_RENTER_FACTORY"),
  vippFactory: required("VIPP_RENTER_FACTORY"),
  musuGuard: required("MUSU_HUB_GUARD"),
  vippGuard: required("VIPP_HUB_GUARD"),
  registry: required("POOL_REGISTRY"),
  vaultFactory: required("PERSONAL_VAULT_FACTORY"),
  quoteSigner: required("QUOTE_SIGNER"),
  keeper: required("MARKET_KEEPER"),
  mgmtAccID: BigInt(required("MGMT_ACC_ID")),
};

const MARKET_ABI = [
  "function admin() view returns (address)",
  "function operatorAddr() view returns (address)",
  "function leaseFactory() view returns (address)",
  "function poolRegistry() view returns (address)",
  "function payItem() view returns (uint32)",
  "function mgmtBps() view returns (uint16)",
  "function mgmtAccID() view returns (uint256)",
];
const FACTORY_ABI = [
  "function market() view returns (address)",
  "function quoteSigner() view returns (address)",
  "function keeper() view returns (address)",
];
const GUARD_ABI = [
  "function market() view returns (address)",
  "function factory() view returns (address)",
];
const REGISTRY_ABI = [
  "function installer() view returns (address)",
  "function factory() view returns (address)",
];
const VAULT_FACTORY_ABI = [
  "function musuMarket() view returns (address)",
  "function vippMarket() view returns (address)",
  "function poolRegistry() view returns (address)",
  "function platformAccID() view returns (uint256)",
];

for (const address of Object.values(expected).filter((value) => typeof value === "string" && value.startsWith("0x"))) {
  expect((await provider.getCode(address)) !== "0x" || same(address, expected.quoteSigner) || same(address, expected.keeper), `missing code at ${address}`);
}

async function verifyMarket(label, marketAddress, payItem, factoryAddress, guardAddress) {
  const market = new Contract(marketAddress, MARKET_ABI, provider);
  const factory = new Contract(factoryAddress, FACTORY_ABI, provider);
  const guard = new Contract(guardAddress, GUARD_ABI, provider);
  const [admin, operator, leaseFactory, registry, item, fee, mgmt, factoryMarket, quoteSigner, keeper, guardMarket, guardFactory] =
    await Promise.all([
      market.admin(), market.operatorAddr(), market.leaseFactory(), market.poolRegistry(), market.payItem(),
      market.mgmtBps(), market.mgmtAccID(), factory.market(), factory.quoteSigner(), factory.keeper(),
      guard.market(), guard.factory(),
    ]);
  expect(admin === "0x0000000000000000000000000000000000000000", `${label}: admin not sealed`);
  expect(same(operator, guardAddress), `${label}: HubGuard is not the game operator`);
  expect(same(leaseFactory, factoryAddress), `${label}: wrong renter factory`);
  expect(same(registry, expected.registry), `${label}: wrong pool registry`);
  expect(Number(item) === payItem && Number(fee) === 1_000, `${label}: wrong currency or fee`);
  expect(BigInt(mgmt) === expected.mgmtAccID, `${label}: wrong management account`);
  expect(same(factoryMarket, marketAddress), `${label}: factory points at wrong market`);
  expect(same(quoteSigner, expected.quoteSigner), `${label}: wrong quote signer`);
  expect(same(keeper, expected.keeper), `${label}: wrong keeper`);
  expect(same(guardMarket, marketAddress) && same(guardFactory, factoryAddress), `${label}: guard wiring mismatch`);
}

expect(!same(expected.quoteSigner, expected.keeper), "quote signer and keeper must be different wallets");
await verifyMarket("MUSU", expected.musuMarket, 1, expected.musuFactory, expected.musuGuard);
await verifyMarket("VIPP", expected.vippMarket, 2, expected.vippFactory, expected.vippGuard);

const registry = new Contract(expected.registry, REGISTRY_ABI, provider);
const vaultFactory = new Contract(expected.vaultFactory, VAULT_FACTORY_ABI, provider);
const [installer, registryFactory, musuMarket, vippMarket, poolRegistry, platformAccID] = await Promise.all([
  registry.installer(), registry.factory(), vaultFactory.musuMarket(), vaultFactory.vippMarket(),
  vaultFactory.poolRegistry(), vaultFactory.platformAccID(),
]);
expect(installer === "0x0000000000000000000000000000000000000000", "registry installer not burned");
expect(same(registryFactory, expected.vaultFactory), "registry factory mismatch");
expect(same(musuMarket, expected.musuMarket) && same(vippMarket, expected.vippMarket), "vault market mismatch");
expect(same(poolRegistry, expected.registry), "vault registry mismatch");
expect(BigInt(platformAccID) === expected.mgmtAccID, "vault platform account mismatch");

console.log("v15 security deployment verified: both markets sealed, registry sealed, roles split, wiring exact");

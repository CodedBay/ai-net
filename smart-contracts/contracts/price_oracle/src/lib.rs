#![no_std]

//! # Price Oracle Contract
//!
//! A standalone Soroban contract that acts as the canonical on-chain price
//! feed for ai-net task pricing with multi-source aggregation.

mod errors;
mod types;

pub use errors::Error;
pub use types::{
    DataKey, FeederSubmission, MaxAgeUpdatedEvent, PriceDeviationRejectedEvent, PriceEntry,
    PriceResult, PriceUpdatedEvent, AGGREGATION_WINDOW_SECS, DEFAULT_MAX_LEDGER_AGE,
    MAX_DEVIATION_PCT, MAX_FEEDERS,
};

use soroban_sdk::{contract, contractimpl, symbol_short, Address, Env, Symbol, Vec};

/// Default maximum price age: 3 600 seconds (1 hour).
pub const DEFAULT_MAX_PRICE_AGE: u64 = 3_600;

/// Persistent-storage TTL to use for price entries: ~7 days at 5 s/ledger.
const PRICE_TTL_LEDGERS: u32 = 17_280 * 7;

// ─── Internal helpers ─────────────────────────────────────────────────────────

fn read_admin(env: &Env) -> Result<Address, Error> {
    env.storage()
        .instance()
        .get(&DataKey::Admin)
        .ok_or(Error::NotInitialized)
}

fn require_admin(env: &Env) -> Result<(), Error> {
    let admin = read_admin(env)?;
    admin.require_auth();
    Ok(())
}

fn read_max_age(env: &Env) -> u64 {
    env.storage()
        .instance()
        .get(&DataKey::MaxPriceAge)
        .unwrap_or(DEFAULT_MAX_PRICE_AGE)
}

fn read_max_ledger_age(env: &Env) -> u32 {
    env.storage()
        .instance()
        .get(&DataKey::MaxLedgerAge)
        .unwrap_or(DEFAULT_MAX_LEDGER_AGE)
}

fn read_feeders(env: &Env) -> Vec<Address> {
    env.storage()
        .instance()
        .get(&DataKey::Feeders)
        .unwrap_or_else(|| Vec::new(env))
}

fn compute_median(_env: &Env, mut prices: Vec<i128>) -> i128 {
    let n = prices.len();
    if n == 0 {
        return 0;
    }
    // Insertion sort
    let mut i = 1u32;
    while i < n {
        let mut j = i;
        while j > 0 {
            let a = prices.get(j - 1).unwrap();
            let b = prices.get(j).unwrap();
            if a > b {
                prices.set(j - 1, b);
                prices.set(j, a);
            } else {
                break;
            }
            j -= 1;
        }
        i += 1;
    }

    if n % 2 == 1 {
        prices.get(n / 2).unwrap()
    } else {
        let a = prices.get(n / 2 - 1).unwrap();
        let b = prices.get(n / 2).unwrap();
        (a + b) / 2
    }
}

// ─── Contract ─────────────────────────────────────────────────────────────────

#[contract]
pub struct PriceOracleContract;

#[contractimpl]
impl PriceOracleContract {
    // ── Lifecycle ─────────────────────────────────────────────────────────────

    pub fn initialize(env: Env, admin: Address, max_price_age: u64) -> Result<(), Error> {
        if env.storage().instance().has(&DataKey::Admin) {
            return Err(Error::AlreadyInitialized);
        }
        admin.require_auth();
        let age = if max_price_age == 0 {
            DEFAULT_MAX_PRICE_AGE
        } else {
            max_price_age
        };
        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage().instance().set(&DataKey::MaxPriceAge, &age);
        env.storage()
            .instance()
            .set(&DataKey::MaxLedgerAge, &DEFAULT_MAX_LEDGER_AGE);

        // Pre-register admin as initial feeder for backward compatibility
        let mut feeders = Vec::new(&env);
        feeders.push_back(admin.clone());
        env.storage().instance().set(&DataKey::Feeders, &feeders);

        Ok(())
    }

    // ── Feeder Management ─────────────────────────────────────────────────────

    pub fn register_feeder(env: Env, feeder: Address) -> Result<(), Error> {
        require_admin(&env)?;
        let mut feeders = read_feeders(&env);
        if feeders.contains(&feeder) {
            return Err(Error::FeederAlreadyRegistered);
        }
        if feeders.len() >= MAX_FEEDERS {
            return Err(Error::MaxFeedersExceeded);
        }
        feeders.push_back(feeder);
        env.storage().instance().set(&DataKey::Feeders, &feeders);
        Ok(())
    }

    pub fn remove_feeder(env: Env, feeder: Address) -> Result<(), Error> {
        require_admin(&env)?;
        let feeders = read_feeders(&env);
        let mut updated = Vec::new(&env);
        for f in feeders.iter() {
            if f != feeder {
                updated.push_back(f);
            }
        }
        env.storage().instance().set(&DataKey::Feeders, &updated);
        Ok(())
    }

    pub fn get_feeders(env: Env) -> Vec<Address> {
        read_feeders(&env)
    }

    pub fn set_max_ledger_age(env: Env, max_age: u32) -> Result<(), Error> {
        require_admin(&env)?;
        if max_age == 0 {
            return Err(Error::InvalidTimestamp);
        }
        env.storage().instance().set(&DataKey::MaxLedgerAge, &max_age);
        Ok(())
    }

    pub fn get_max_ledger_age(env: Env) -> u32 {
        read_max_ledger_age(&env)
    }

    // ── Price Submission ──────────────────────────────────────────────────────

    pub fn submit_feeder_price(
        env: Env,
        feeder: Address,
        pair: Symbol,
        price: i128,
        timestamp: u64,
    ) -> Result<(), Error> {
        feeder.require_auth();

        let feeders = read_feeders(&env);
        if !feeders.contains(&feeder) {
            return Err(Error::FeederNotRegistered);
        }
        if price <= 0 {
            return Err(Error::InvalidPrice);
        }
        let now = env.ledger().timestamp();
        if timestamp > now {
            return Err(Error::InvalidTimestamp);
        }

        let sub_key = DataKey::Submissions(pair.clone());
        let current_subs: Vec<FeederSubmission> = env
            .storage()
            .persistent()
            .get(&sub_key)
            .unwrap_or_else(|| Vec::new(&env));

        // Filter active submissions within 5-min aggregation window
        let mut active_subs = Vec::new(&env);
        let mut active_prices = Vec::new(&env);
        for sub in current_subs.iter() {
            if sub.feeder != feeder && now.saturating_sub(sub.timestamp) <= AGGREGATION_WINDOW_SECS {
                active_subs.push_back(sub.clone());
                active_prices.push_back(sub.price);
            }
        }

        // Deviation check against current median if other active submissions exist
        if !active_prices.is_empty() {
            let current_median = compute_median(&env, active_prices.clone());
            let diff = if price >= current_median {
                price - current_median
            } else {
                current_median - price
            };
            let dev_pct = ((diff * 100) / current_median) as u32;
            if dev_pct > (MAX_DEVIATION_PCT as u32) {
                env.events().publish(
                    (symbol_short!("oracle"), symbol_short!("rejected")),
                    PriceDeviationRejectedEvent {
                        version: 1,
                        feeder: feeder.clone(),
                        submitted_price: price,
                        median: current_median,
                        deviation_pct: dev_pct,
                        ledger: env.ledger().sequence(),
                    },
                );
                return Err(Error::PriceDeviationTooHigh);
            }
        }

        // Add this feeder's submission
        let new_sub = FeederSubmission {
            feeder: feeder.clone(),
            price,
            timestamp,
            ledger: env.ledger().sequence(),
        };
        active_subs.push_back(new_sub);
        active_prices.push_back(price);

        env.storage().persistent().set(&sub_key, &active_subs);
        env.storage().persistent().extend_ttl(
            &sub_key,
            PRICE_TTL_LEDGERS.saturating_sub(1),
            PRICE_TTL_LEDGERS,
        );

        // Compute median
        let median = compute_median(&env, active_prices);
        let current_ledger = env.ledger().sequence();
        let entry = PriceEntry {
            price: median,
            timestamp,
            ledger: current_ledger,
        };

        let price_key = DataKey::Price(pair.clone());
        env.storage().persistent().set(&price_key, &entry);
        env.storage().persistent().extend_ttl(
            &price_key,
            PRICE_TTL_LEDGERS.saturating_sub(1),
            PRICE_TTL_LEDGERS,
        );

        env.events().publish(
            (symbol_short!("oracle"), symbol_short!("updated")),
            PriceUpdatedEvent {
                version: 1,
                asset: pair,
                price,
                median,
                num_feeders: active_subs.len(),
                ledger: current_ledger,
            },
        );

        Ok(())
    }

    pub fn submit_price(env: Env, pair: Symbol, price: i128, timestamp: u64) -> Result<(), Error> {
        let admin = read_admin(&env)?;
        admin.require_auth();
        Self::submit_feeder_price(env, admin, pair, price, timestamp)
    }

    pub fn set_max_price_age(env: Env, new_max_age: u64) -> Result<(), Error> {
        require_admin(&env)?;
        if new_max_age == 0 {
            return Err(Error::InvalidTimestamp);
        }
        let old_max_age = read_max_age(&env);
        env.storage()
            .instance()
            .set(&DataKey::MaxPriceAge, &new_max_age);

        env.events().publish(
            (symbol_short!("oracle"), symbol_short!("age_set")),
            MaxAgeUpdatedEvent {
                version: 1,
                old_max_age,
                new_max_age,
                ledger: env.ledger().sequence(),
            },
        );

        Ok(())
    }

    // ── IPriceOracle interface ─────────────────────────────────────────────────

    pub fn get_price(env: Env, pair: Symbol) -> Result<PriceResult, Error> {
        let key = DataKey::Price(pair.clone());
        let entry: PriceEntry = env
            .storage()
            .persistent()
            .get(&key)
            .ok_or(Error::FeedNotFound)?;

        let now = env.ledger().timestamp();
        let max_age = read_max_age(&env);
        if now.saturating_sub(entry.timestamp) > max_age {
            return Err(Error::PriceStale);
        }

        let max_ledger_age = read_max_ledger_age(&env);
        let current_ledger = env.ledger().sequence();
        if current_ledger.saturating_sub(entry.ledger) > max_ledger_age {
            return Err(Error::PriceStale);
        }

        Ok(PriceResult {
            pair,
            price: entry.price,
            timestamp: entry.timestamp,
        })
    }

    pub fn get_max_age(env: Env) -> u64 {
        read_max_age(&env)
    }

    pub fn get_admin(env: Env) -> Result<Address, Error> {
        read_admin(&env)
    }
}

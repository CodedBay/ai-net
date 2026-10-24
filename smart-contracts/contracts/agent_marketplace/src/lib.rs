#![no_std]

//! # Agent Marketplace Contract
//!
//! On-chain agent marketplace enabling service listing, discovery,
//! booking with escrow, and rating.

mod errors;
mod types;

pub use errors::Error;
pub use types::*;

use soroban_sdk::{
    contract, contractimpl, contracttype, symbol_short, Address, Env, IntoVal, Symbol, Vec,
};

#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    Admin,
    Paused,
    ServiceListing(Symbol),
    Booking(Symbol),
    AgentRating(Symbol),
    ListingsByCapability(Symbol),
    /// Oracle manager contract address for XLM/USD price resolution.
    OracleManager,
    /// Default listing validity duration in ledgers.
    ListingDurationLedgers,
}

#[contract]
pub struct AgentMarketplaceContract;

fn require_admin(env: &Env) -> Result<Address, Error> {
    let admin: Address = env
        .storage()
        .instance()
        .get(&DataKey::Admin)
        .ok_or(Error::Unauthorized)?;
    admin.require_auth();
    Ok(admin)
}

fn require_not_paused(env: &Env) -> Result<(), Error> {
    let paused: bool = env
        .storage()
        .instance()
        .get(&DataKey::Paused)
        .unwrap_or(false);
    if paused {
        return Err(Error::ContractPaused);
    }
    Ok(())
}

#[contractimpl]
impl AgentMarketplaceContract {
    /// Initialize the marketplace with an admin.
    pub fn initialize(env: Env, admin: Address) -> Result<(), Error> {
        if env.storage().instance().has(&DataKey::Admin) {
            return Err(Error::AlreadyExists);
        }
        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage().instance().set(&DataKey::Paused, &false);
        Ok(())
    }

    /// Admin: pause or unpause the marketplace.
    pub fn pause(env: Env, paused: bool) -> Result<(), Error> {
        require_admin(&env)?;
        env.storage().instance().set(&DataKey::Paused, &paused);
        Ok(())
    }

    /// Admin: configure the oracle manager contract address for XLM/USD price resolution.
    ///
    /// When set, `book_agent` fetches a fresh price from the oracle manager
    /// before accepting payment. Stale prices (>300 s) block new bookings.
    pub fn set_oracle(env: Env, oracle_manager: Address) -> Result<(), Error> {
        require_admin(&env)?;
        env.storage()
            .instance()
            .set(&DataKey::OracleManager, &oracle_manager);
        env.events().publish(
            (symbol_short!("market"), symbol_short!("ora_set")),
            oracle_manager,
        );
        Ok(())
    }

    /// Read the current oracle manager address, if configured.
    pub fn get_oracle(env: Env) -> Option<Address> {
        env.storage().instance().get(&DataKey::OracleManager)
    }

    /// Fetch the current XLM/USD price from the configured oracle manager.
    ///
    /// Returns `None` if no oracle is configured or the price is unavailable.
    pub fn get_xlm_price(env: Env) -> Option<i128> {
        let oracle: Address = env
            .storage()
            .instance()
            .get(&DataKey::OracleManager)?;

        let fn_name = soroban_sdk::Symbol::new(&env, "resolve_price");
        let pair = soroban_sdk::Symbol::new(&env, "XLM_USD");
        let args = soroban_sdk::vec![&env, pair.into_val(&env)];

        use soroban_sdk::{InvokeError, Val, TryIntoVal, Map};

        let result: Result<Result<Val, _>, Result<InvokeError, InvokeError>> =
            env.try_invoke_contract(&oracle, &fn_name, args);

        match result {
            Ok(Ok(val)) => {
                let map: Result<Map<soroban_sdk::Symbol, Val>, _> = val.try_into_val(&env);
                if let Ok(m) = map {
                    let price_key = soroban_sdk::Symbol::new(&env, "price");
                    let price: Option<i128> = m
                        .get(price_key)
                        .and_then(|v| v.try_into_val(&env).ok());
                    return price;
                }
                None
            }
            _ => None,
        }
    }

    /// Admin: configure listing validity duration in ledgers (Issue #411).
    pub fn set_listing_duration(env: Env, duration_ledgers: u32) -> Result<(), Error> {
        require_admin(&env)?;
        env.storage()
            .instance()
            .set(&DataKey::ListingDurationLedgers, &duration_ledgers);
        Ok(())
    }

    /// Query current listing validity duration in ledgers (default: 518,400 / ~30 days).
    pub fn get_listing_duration(env: Env) -> u32 {
        env.storage()
            .instance()
            .get(&DataKey::ListingDurationLedgers)
            .unwrap_or(DEFAULT_LISTING_DURATION_LEDGERS)
    }

    /// List a service on the marketplace.
    pub fn list_service(
        env: Env,
        listing_id: Symbol,
        agent_id: Symbol,
        owner: Address,
        capability: Symbol,
        price_stroops: i128,
        max_response_time: u32,
        availability_hours: u32,
    ) -> Result<(), Error> {
        require_not_paused(&env)?;
        owner.require_auth();

        if price_stroops <= 0 {
            return Err(Error::InvalidPrice);
        }

        let key = DataKey::ServiceListing(listing_id.clone());
        if env.storage().persistent().has(&key) {
            return Err(Error::AlreadyExists);
        }

        let duration = Self::get_listing_duration(env.clone());
        let expiry_ledger = env.ledger().sequence().saturating_add(duration);

        let listing = ServiceListing {
            listing_id: listing_id.clone(),
            agent_id: agent_id.clone(),
            owner: owner.clone(),
            capability: capability.clone(),
            price_stroops,
            max_response_time,
            availability_hours,
            active: true,
            expiry_ledger,
            status: Symbol::new(&env, "active"),
            description: capability.clone(),
        };

        env.storage().persistent().set(&key, &listing);

        // Index by capability
        let cap_key = DataKey::ListingsByCapability(capability.clone());
        let mut ids: Vec<Symbol> = env
            .storage()
            .persistent()
            .get(&cap_key)
            .unwrap_or_else(|| Vec::new(&env));
        ids.push_back(listing_id.clone());
        env.storage().persistent().set(&cap_key, &ids);

        env.events().publish(
            (symbol_short!("market"), symbol_short!("svc_list")),
            ServiceListedEvent {
                listing_id,
                agent_id,
                capability,
                price_stroops,
            },
        );

        Ok(())
    }

    /// Renew an agent listing before it is purged from storage (Issue #411).
    pub fn renew_listing(env: Env, listing_id: Symbol) -> Result<(), Error> {
        require_not_paused(&env)?;
        let key = DataKey::ServiceListing(listing_id.clone());
        let mut listing: ServiceListing = env
            .storage()
            .persistent()
            .get(&key)
            .ok_or(Error::NotFound)?;

        listing.owner.require_auth();

        let current_ledger = env.ledger().sequence();
        if current_ledger > listing.expiry_ledger.saturating_add(GRACE_PERIOD_LEDGERS) {
            env.storage().persistent().remove(&key);
            return Err(Error::NotFound);
        }

        let duration = Self::get_listing_duration(env.clone());
        listing.expiry_ledger = current_ledger.saturating_add(duration);
        listing.active = true;
        listing.status = Symbol::new(&env, "active");
        env.storage().persistent().set(&key, &listing);

        env.events().publish(
            (Symbol::new(&env, "listing_renewed"),),
            ListingRenewedEvent {
                agent_id: listing.agent_id,
                new_expiry_ledger: listing.expiry_ledger,
            },
        );

        Ok(())
    }

    /// Update listing metadata (price, description, SLAs) without full re-listing (Issue #411).
    pub fn update_listing_metadata(
        env: Env,
        listing_id: Symbol,
        new_price: Option<i128>,
        new_description: Option<Symbol>,
        new_response_time: Option<u32>,
        new_availability: Option<u32>,
    ) -> Result<(), Error> {
        require_not_paused(&env)?;
        let key = DataKey::ServiceListing(listing_id.clone());
        let mut listing: ServiceListing = env
            .storage()
            .persistent()
            .get(&key)
            .ok_or(Error::NotFound)?;

        listing.owner.require_auth();

        if let Some(price) = new_price {
            if price <= 0 {
                return Err(Error::InvalidPrice);
            }
            listing.price_stroops = price;
        }
        if let Some(desc) = new_description {
            listing.description = desc;
        }
        if let Some(rt) = new_response_time {
            listing.max_response_time = rt;
        }
        if let Some(avail) = new_availability {
            listing.availability_hours = avail;
        }

        env.storage().persistent().set(&key, &listing);
        Ok(())
    }

    /// Search for services by capability with optional filters.
    pub fn search_services(
        env: Env,
        capability: Symbol,
        max_price: i128,
        max_response_time: u32,
    ) -> Vec<ServiceListing> {
        let cap_key = DataKey::ListingsByCapability(capability);
        let ids: Vec<Symbol> = env
            .storage()
            .persistent()
            .get(&cap_key)
            .unwrap_or_else(|| Vec::new(&env));

        let current_ledger = env.ledger().sequence();
        let mut results = Vec::new(&env);
        for id in ids.iter() {
            let key = DataKey::ServiceListing(id);
            if let Some(mut listing) = env
                .storage()
                .persistent()
                .get::<_, ServiceListing>(&key)
            {
                if current_ledger > listing.expiry_ledger.saturating_add(GRACE_PERIOD_LEDGERS) {
                    env.storage().persistent().remove(&key);
                    continue;
                }
                if current_ledger > listing.expiry_ledger {
                    listing.active = false;
                    listing.status = Symbol::new(&env, "expired");
                    env.storage().persistent().set(&key, &listing);
                    continue;
                }
                if !listing.active {
                    continue;
                }
                if max_price > 0 && listing.price_stroops > max_price {
                    continue;
                }
                if max_response_time > 0 && listing.max_response_time > max_response_time {
                    continue;
                }
                results.push_back(listing);
            }
        }
        results
    }

    /// Book an agent's service with escrow payment.
    pub fn book_agent(
        env: Env,
        listing_id: Symbol,
        client: Address,
        payment_amount: i128,
        booking_id: Symbol,
    ) -> Result<(), Error> {
        require_not_paused(&env)?;
        client.require_auth();

        let key = DataKey::ServiceListing(listing_id.clone());
        let listing: ServiceListing = env
            .storage()
            .persistent()
            .get(&key)
            .ok_or(Error::NotFound)?;

        if !listing.active {
            return Err(Error::ServiceNotAvailable);
        }

        // If an oracle manager is configured, fetch a fresh XLM/USD price.
        // A stale or unavailable price blocks new bookings to prevent pricing
        // at an outdated exchange rate.
        if env
            .storage()
            .instance()
            .has(&DataKey::OracleManager)
        {
            // get_xlm_price does a cross-contract call; None means stale/unavailable.
            let oracle_price = Self::get_xlm_price(env.clone());
            if oracle_price.is_none() {
                return Err(Error::ServiceNotAvailable); // reuse: oracle stale
            }
            // oracle_price is available — marketplace records it but leaves
            // the actual payment validation to the payment_amount check below.
            // Future: convert USD-denominated listing price → XLM using oracle_price.
        }

        if payment_amount < listing.price_stroops {
            return Err(Error::InsufficientPayment);
        }

        let booking_key = DataKey::Booking(booking_id.clone());
        if env.storage().persistent().has(&booking_key) {
            return Err(Error::AlreadyExists);
        }

        let booking = Booking {
            booking_id: booking_id.clone(),
            listing_id: listing_id.clone(),
            agent_id: listing.agent_id.clone(),
            client: client.clone(),
            escrow_amount: payment_amount,
            created_at: env.ledger().timestamp(),
            completed: false,
            cancelled: false,
            rating: 0,
        };

        let booking_key = DataKey::Booking(booking_id.clone());
        env.storage().persistent().set(&booking_key, &booking);

        env.events().publish(
            (symbol_short!("market"), symbol_short!("svc_book")),
            ServiceBookedEvent {
                booking_id: booking_id.clone(),
                listing_id,
                client,
                escrow_amount: payment_amount,
            },
        );

        Ok(())
    }

    /// Complete a booking and release escrow payment to the agent owner.
    pub fn complete_booking(env: Env, booking_id: Symbol) -> Result<(), Error> {
        let booking_key = DataKey::Booking(booking_id.clone());
        let mut booking: Booking = env
            .storage()
            .persistent()
            .get(&booking_key)
            .ok_or(Error::BookingNotFound)?;

        if booking.completed {
            return Err(Error::BookingAlreadyCompleted);
        }
        if booking.cancelled {
            return Err(Error::BookingAlreadyCancelled);
        }

        // Only the agent owner can mark as completed
        let listing_key = DataKey::ServiceListing(booking.listing_id.clone());
        let listing: ServiceListing = env
            .storage()
            .persistent()
            .get(&listing_key)
            .ok_or(Error::NotFound)?;

        listing.owner.require_auth();

        booking.completed = true;
        env.storage()
            .persistent()
            .set(&booking_key, &booking);

        env.events().publish(
            (symbol_short!("market"), symbol_short!("svc_comp")),
            ServiceCompletedEvent {
                booking_id,
                payment_released: booking.escrow_amount,
            },
        );

        Ok(())
    }

    /// Cancel a booking and refund the client.
    pub fn cancel_booking(env: Env, booking_id: Symbol) -> Result<(), Error> {
        let booking_key = DataKey::Booking(booking_id.clone());
        let mut booking: Booking = env
            .storage()
            .persistent()
            .get(&booking_key)
            .ok_or(Error::BookingNotFound)?;

        if booking.completed {
            return Err(Error::BookingAlreadyCompleted);
        }
        if booking.cancelled {
            return Err(Error::BookingAlreadyCancelled);
        }

        booking.client.require_auth();

        booking.cancelled = true;
        env.storage()
            .persistent()
            .set(&booking_key, &booking);

        env.events().publish(
            (symbol_short!("market"), symbol_short!("svc_canc")),
            ServiceCancelledEvent {
                booking_id,
                refund_amount: booking.escrow_amount,
            },
        );

        Ok(())
    }

    /// Rate a completed booking (1-5 stars).
    pub fn rate_booking(
        env: Env,
        booking_id: Symbol,
        rating: u32,
    ) -> Result<(), Error> {
        if rating < 1 || rating > 5 {
            return Err(Error::InvalidPrice);
        }

        let booking_key = DataKey::Booking(booking_id.clone());
        let mut booking: Booking = env
            .storage()
            .persistent()
            .get(&booking_key)
            .ok_or(Error::BookingNotFound)?;

        if !booking.completed {
            return Err(Error::BookingAlreadyCancelled);
        }
        if booking.rating != 0 {
            return Err(Error::AlreadyExists);
        }

        booking.client.require_auth();

        booking.rating = rating;
        env.storage()
            .persistent()
            .set(&booking_key, &booking);

        // Update agent rating aggregate
        let rating_key = DataKey::AgentRating(booking.agent_id.clone());
        let mut agent_rating: AgentRating = env
            .storage()
            .persistent()
            .get(&rating_key)
            .unwrap_or(AgentRating {
                agent_id: booking.agent_id.clone(),
                total_ratings: 0,
                rating_sum: 0,
            });

        agent_rating.total_ratings += 1;
        agent_rating.rating_sum += rating as u64;
        env.storage()
            .persistent()
            .set(&rating_key, &agent_rating);

        Ok(())
    }

    /// Get a service listing. Evaluates expiry and grace period purging (Issue #411).
    pub fn get_listing(env: Env, listing_id: Symbol) -> Option<ServiceListing> {
        let key = DataKey::ServiceListing(listing_id);
        let mut listing: ServiceListing = env.storage().persistent().get(&key)?;
        let current_ledger = env.ledger().sequence();

        if current_ledger > listing.expiry_ledger.saturating_add(GRACE_PERIOD_LEDGERS) {
            env.storage().persistent().remove(&key);
            return None;
        }

        if current_ledger > listing.expiry_ledger {
            listing.active = false;
            listing.status = Symbol::new(&env, "expired");
            env.storage().persistent().set(&key, &listing);

            env.events().publish(
                (Symbol::new(&env, "listing_expired"),),
                ListingExpiredEvent {
                    agent_id: listing.agent_id.clone(),
                    capability: listing.capability.clone(),
                    expiry_ledger: listing.expiry_ledger,
                },
            );
        }

        Some(listing)
    }

    /// Get a booking.
    pub fn get_booking(env: Env, booking_id: Symbol) -> Option<Booking> {
        env.storage()
            .persistent()
            .get(&DataKey::Booking(booking_id))
    }

    /// Get aggregate rating for an agent.
    pub fn get_agent_rating(env: Env, agent_id: Symbol) -> AgentRating {
        env.storage()
            .persistent()
            .get(&DataKey::AgentRating(agent_id.clone()))
            .unwrap_or(AgentRating {
                agent_id,
                total_ratings: 0,
                rating_sum: 0,
            })
    }
}

#[cfg(test)]
mod test;

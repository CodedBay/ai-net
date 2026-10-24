/// Integration tests for the DisputeResolution contract.
///
/// Covers:
/// - Happy path: client wins (majority vote for client)
/// - Happy path: agent wins (majority vote for agent)
/// - Evidence submission phase
/// - Appeal within the appeal window
/// - Auth errors: non-juror cannot vote
/// - Duplicate vote rejected
/// - Resolve before voting deadline rejected
#[cfg(test)]
mod integration_tests {
    use crate::{
        DisputeResolutionContract, DisputeResolutionContractClient, DisputeStatus, Error, VoteSide,
    };
    use soroban_sdk::{
        testutils::{Address as _, Ledger},
        Address, BytesN, Env, Symbol,
    };

    // Evidence + Voting + Appeal phase lengths (seconds) — mirrors lib.rs constants.
    const EVIDENCE_PHASE: u64 = 259_200;
    const VOTING_PHASE: u64 = 172_800;
    const APPEAL_WINDOW: u64 = 172_800;

    // ─── Fixture ─────────────────────────────────────────────────────────────

    struct Fixture {
        env: Env,
        client: DisputeResolutionContractClient<'static>,
        admin: Address,
        filer: Address,
        agent_addr: Address,
        dispute_id: Symbol,
        jurors: [Address; 5],
    }

    fn fixture() -> Fixture {
        let env = Env::default();
        env.mock_all_auths();
        env.ledger().with_mut(|l| {
            l.timestamp = 1_700_000_000;
            l.sequence_number = 100;
        });

        let contract_id = env.register(DisputeResolutionContract, ());
        let client = DisputeResolutionContractClient::new(&env, &contract_id);

        let admin = Address::generate(&env);
        client.initialize(&admin);

        let jurors: [Address; 5] = core::array::from_fn(|_| Address::generate(&env));

        // Register the juror pool.
        let juror_vec = soroban_sdk::Vec::from_array(
            &env,
            [
                jurors[0].clone(),
                jurors[1].clone(),
                jurors[2].clone(),
                jurors[3].clone(),
                jurors[4].clone(),
            ],
        );
        client.set_jurors(&juror_vec);

        Fixture {
            filer: Address::generate(&env),
            agent_addr: Address::generate(&env),
            dispute_id: Symbol::new(&env, "dispute1"),
            env,
            client,
            admin,
            jurors,
        }
    }

    fn file(f: &Fixture) {
        f.client.file_dispute(&f.filer, &f.agent_addr.clone().into(), &f.dispute_id);
    }

    fn advance_past_voting(f: &Fixture) {
        f.env.ledger().with_mut(|l| {
            l.timestamp += EVIDENCE_PHASE + VOTING_PHASE + 1;
        });
    }

    // ─── Tests ───────────────────────────────────────────────────────────────

    #[test]
    fn test_file_dispute_succeeds() {
        let f = fixture();
        let result = f.client.try_file_dispute(&f.filer, &f.agent_addr.clone().into(), &f.dispute_id);
        assert!(result.is_ok(), "file_dispute should succeed: {result:?}");

        let dispute = f.client.get_dispute(&f.dispute_id);
        assert!(dispute.is_some(), "dispute should exist after filing");
        assert_eq!(dispute.unwrap().status, DisputeStatus::Filed);
    }

    #[test]
    fn test_duplicate_dispute_rejected() {
        let f = fixture();
        file(&f);
        let dup = f.client.try_file_dispute(&f.filer, &f.agent_addr.clone().into(), &f.dispute_id);
        assert_eq!(dup, Err(Ok(Error::AlreadyExists)), "duplicate dispute must be rejected");
    }

    #[test]
    fn test_submit_evidence_transitions_to_evidence_phase() {
        let f = fixture();
        file(&f);

        let evidence_hash = BytesN::from_array(&f.env, &[0xABu8; 32]);
        let result = f.client.try_submit_evidence(&f.dispute_id, &f.filer, &evidence_hash);
        assert!(result.is_ok(), "submit_evidence should succeed: {result:?}");

        let dispute = f.client.get_dispute(&f.dispute_id).unwrap();
        assert_eq!(dispute.status, DisputeStatus::EvidenceSubmission);
    }

    #[test]
    fn test_full_dispute_client_wins() {
        let f = fixture();
        file(&f);

        // Three jurors vote for the client.
        f.client.cast_vote(&f.dispute_id, &f.jurors[0], &VoteSide::Client);
        f.client.cast_vote(&f.dispute_id, &f.jurors[1], &VoteSide::Client);
        f.client.cast_vote(&f.dispute_id, &f.jurors[2], &VoteSide::Client);
        // Two jurors vote for the agent.
        f.client.cast_vote(&f.dispute_id, &f.jurors[3], &VoteSide::Agent);
        f.client.cast_vote(&f.dispute_id, &f.jurors[4], &VoteSide::Agent);

        advance_past_voting(&f);

        let result = f.client.try_resolve_dispute(&f.dispute_id);
        assert!(result.is_ok(), "resolve_dispute should succeed: {result:?}");

        let dispute = f.client.get_dispute(&f.dispute_id).unwrap();
        assert_eq!(dispute.status, DisputeStatus::Resolved);
        // resolution = 0 means client wins.
        assert_eq!(dispute.resolution, Some(0u32), "client should win with majority");
    }

    #[test]
    fn test_full_dispute_agent_wins() {
        let f = fixture();
        file(&f);

        // Three jurors vote for the agent.
        f.client.cast_vote(&f.dispute_id, &f.jurors[0], &VoteSide::Agent);
        f.client.cast_vote(&f.dispute_id, &f.jurors[1], &VoteSide::Agent);
        f.client.cast_vote(&f.dispute_id, &f.jurors[2], &VoteSide::Agent);
        // Two jurors vote for the client.
        f.client.cast_vote(&f.dispute_id, &f.jurors[3], &VoteSide::Client);
        f.client.cast_vote(&f.dispute_id, &f.jurors[4], &VoteSide::Client);

        advance_past_voting(&f);

        f.client.resolve_dispute(&f.dispute_id);

        let dispute = f.client.get_dispute(&f.dispute_id).unwrap();
        // resolution = 1 means agent wins.
        assert_eq!(dispute.resolution, Some(1u32), "agent should win with majority");
    }

    #[test]
    fn test_non_juror_cannot_vote() {
        let f = fixture();
        file(&f);

        let non_juror = Address::generate(&f.env);
        let result = f.client.try_cast_vote(&f.dispute_id, &non_juror, &VoteSide::Client);
        assert_eq!(result, Err(Ok(Error::NotJuror)), "non-juror must not be able to vote");
    }

    #[test]
    fn test_duplicate_vote_rejected() {
        let f = fixture();
        file(&f);

        f.client.cast_vote(&f.dispute_id, &f.jurors[0], &VoteSide::Client);
        let dup = f.client.try_cast_vote(&f.dispute_id, &f.jurors[0], &VoteSide::Agent);
        assert_eq!(dup, Err(Ok(Error::JurorAlreadyVoted)), "duplicate vote must be rejected");
    }

    #[test]
    fn test_resolve_before_voting_deadline_rejected() {
        let f = fixture();
        file(&f);

        // Attempt to resolve immediately without advancing past voting deadline.
        let result = f.client.try_resolve_dispute(&f.dispute_id);
        assert!(result.is_err(), "resolve_dispute before deadline must be rejected");
    }

    #[test]
    fn test_appeal_within_window_succeeds() {
        let f = fixture();
        file(&f);

        // Vote unanimously and resolve.
        for juror in &f.jurors {
            f.client.cast_vote(&f.dispute_id, juror, &VoteSide::Client);
        }
        advance_past_voting(&f);
        f.client.resolve_dispute(&f.dispute_id);

        // Appeal within the appeal window.
        let appellant = f.filer.clone();
        let result = f.client.try_appeal_dispute(&f.dispute_id, &appellant);
        assert!(result.is_ok(), "appeal within window should succeed: {result:?}");

        let dispute = f.client.get_dispute(&f.dispute_id).unwrap();
        assert_eq!(dispute.status, DisputeStatus::Appealed);
        assert!(dispute.appealed, "dispute.appealed must be true after appeal");
    }

    #[test]
    fn test_appeal_after_window_rejected() {
        let f = fixture();
        file(&f);

        for juror in &f.jurors {
            f.client.cast_vote(&f.dispute_id, juror, &VoteSide::Client);
        }
        advance_past_voting(&f);
        f.client.resolve_dispute(&f.dispute_id);

        // Advance past the appeal window too.
        f.env.ledger().with_mut(|l| {
            l.timestamp += APPEAL_WINDOW + 1;
        });

        let result = f.client.try_appeal_dispute(&f.dispute_id, &f.filer);
        assert_eq!(result, Err(Ok(Error::AppealWindowClosed)), "appeal after window must be rejected");
    }

    #[test]
    fn test_resolve_already_resolved_rejected() {
        let f = fixture();
        file(&f);

        for juror in &f.jurors {
            f.client.cast_vote(&f.dispute_id, juror, &VoteSide::Agent);
        }
        advance_past_voting(&f);
        f.client.resolve_dispute(&f.dispute_id);

        let result = f.client.try_resolve_dispute(&f.dispute_id);
        assert_eq!(result, Err(Ok(Error::DisputeAlreadyResolved)));
    }
}

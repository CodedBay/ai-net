#![cfg(test)]

use super::*;
use soroban_sdk::{testutils::Address as _, vec, Env, String};

fn setup() -> (Env, AgentRegistryClient<'static>, Address) {
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register(AgentRegistry, ());
    let client = AgentRegistryClient::new(&env, &contract_id);
    let owner = Address::generate(&env);
    (env, client, owner)
}

fn caps(env: &Env) -> Vec<String> {
    vec![env, String::from_str(env, "nlp"), String::from_str(env, "vision")]
}

#[test]
fn test_register_agent_success() {
    let (env, client, owner) = setup();
    let id = client.register_agent(
        &owner,
        &String::from_str(&env, "Agent A"),
        &caps(&env),
        &100i128,
        &String::from_str(&env, "https://a.example"),
    );
    assert_eq!(id, 1);

    let record = client.get_agent(&id);
    assert_eq!(record.agent_id, 1);
    assert_eq!(record.owner, owner);
    assert_eq!(record.price_xlm, 100);
}

#[test]
fn test_register_multiple_agents() {
    let (env, client, owner) = setup();
    let id1 = client.register_agent(
        &owner,
        &String::from_str(&env, "A"),
        &caps(&env),
        &10i128,
        &String::from_str(&env, "https://a"),
    );
    let id2 = client.register_agent(
        &owner,
        &String::from_str(&env, "B"),
        &caps(&env),
        &20i128,
        &String::from_str(&env, "https://b"),
    );
    assert_eq!(id1, 1);
    assert_eq!(id2, 2);
}

#[test]
fn test_too_many_capabilities() {
    let (env, client, owner) = setup();
    let mut many: Vec<String> = Vec::new(&env);
    for i in 0..51u32 {
        many.push_back(String::from_str(&env, "cap"));
        let _ = i;
    }
    let res = client.try_register_agent(
        &owner,
        &String::from_str(&env, "A"),
        &many,
        &10i128,
        &String::from_str(&env, "https://a"),
    );
    assert!(res.is_err());
}

#[test]
fn test_invalid_price_rejected() {
    let (env, client, owner) = setup();
    let res = client.try_register_agent(
        &owner,
        &String::from_str(&env, "A"),
        &caps(&env),
        &-1i128,
        &String::from_str(&env, "https://a"),
    );
    assert!(res.is_err());
}

#[test]
fn test_deregister_agent() {
    let (env, client, owner) = setup();
    let id = client.register_agent(
        &owner,
        &String::from_str(&env, "A"),
        &caps(&env),
        &10i128,
        &String::from_str(&env, "https://a"),
    );
    client.deregister_agent(&id);
    let res = client.try_get_agent(&id);
    assert!(res.is_err());
}

#[test]
fn test_deregister_unauthorized() {
    let env = Env::default();
    let contract_id = env.register(AgentRegistry, ());
    let client = AgentRegistryClient::new(&env, &contract_id);

    let owner = Address::generate(&env);
    let attacker = Address::generate(&env);

    env.mock_all_auths();
    let id = client.register_agent(
        &owner,
        &String::from_str(&env, "A"),
        &caps(&env),
        &10i128,
        &String::from_str(&env, "https://a"),
    );

    // Only authorize the attacker; contract should reject because owner != attacker
    env.mock_auths(&[soroban_sdk::testutils::MockAuth {
        address: &attacker,
        invoke: &soroban_sdk::testutils::MockAuthInvoke {
            contract: &contract_id,
            fn_name: "deregister_agent",
            args: (id,).into_val(&env),
            sub_invokes: &[],
        },
    }]);

    let res = client.try_deregister_agent(&id);
    assert!(res.is_err());
}

#[test]
fn test_update_agent() {
    let (env, client, owner) = setup();
    let id = client.register_agent(
        &owner,
        &String::from_str(&env, "Old"),
        &caps(&env),
        &10i128,
        &String::from_str(&env, "https://old"),
    );

    client.update_agent(
        &id,
        &Some(String::from_str(&env, "New")),
        &None,
        &Some(999i128),
        &Some(String::from_str(&env, "https://new")),
    );

    let record = client.get_agent(&id);
    assert_eq!(record.name, String::from_str(&env, "New"));
    assert_eq!(record.price_xlm, 999);
    assert_eq!(record.endpoint, String::from_str(&env, "https://new"));
}

#[test]
fn test_list_agents_pagination() {
    let (env, client, owner) = setup();
    for _ in 0..5 {
        client.register_agent(
            &owner,
            &String::from_str(&env, "A"),
            &caps(&env),
            &10i128,
            &String::from_str(&env, "https://a"),
        );
    }

    let page1 = client.list_agents(&0u64, &2u32);
    assert_eq!(page1.len(), 2);
    assert_eq!(page1.get(0).unwrap().agent_id, 1);
    assert_eq!(page1.get(1).unwrap().agent_id, 2);

    let page2 = client.list_agents(&2u64, &2u32);
    assert_eq!(page2.len(), 2);
    assert_eq!(page2.get(0).unwrap().agent_id, 3);
    assert_eq!(page2.get(1).unwrap().agent_id, 4);

    let page3 = client.list_agents(&4u64, &10u32);
    assert_eq!(page3.len(), 1);
    assert_eq!(page3.get(0).unwrap().agent_id, 5);
}

#[test]
fn test_list_agents_zero_limit() {
    let (env, client, owner) = setup();
    client.register_agent(
        &owner,
        &String::from_str(&env, "A"),
        &caps(&env),
        &10i128,
        &String::from_str(&env, "https://a"),
    );
    let res = client.list_agents(&0u64, &0u32);
    assert_eq!(res.len(), 0);
}

#[test]
fn test_events_emitted() {
    use soroban_sdk::testutils::Events as _;
    let (env, client, owner) = setup();
    let id = client.register_agent(
        &owner,
        &String::from_str(&env, "A"),
        &caps(&env),
        &10i128,
        &String::from_str(&env, "https://a"),
    );
    client.deregister_agent(&id);

    let events = env.events().all();
    assert!(events.len() >= 2);
}

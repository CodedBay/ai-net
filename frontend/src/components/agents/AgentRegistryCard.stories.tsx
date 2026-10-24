/**
 * AgentRegistryCard.stories.tsx
 *
 * NOTE: Storybook is not installed in this project (@storybook/* packages are
 * absent from frontend/package.json). This file is a STUB that documents
 * component usage and serves as a ready-to-use story once Storybook is added.
 *
 * To enable these stories:
 *   npx storybook@latest init   # inside frontend/
 *
 * ---------------------------------------------------------------------------
 * Component: AgentRegistryCard
 * Usage example:
 *
 *   import { AgentRegistryCard } from './AgentRegistryCard';
 *
 *   <AgentRegistryCard
 *     agent={{
 *       id: 'agent-research-001',
 *       name: 'Research Specialist',
 *       capabilities: ['research', 'report'],
 *       price: 0.5,
 *       reputation: 4.8,
 *       status: 'active',
 *     }}
 *     onHire={(agent) => console.log('Hire:', agent.name)}
 *   />
 * ---------------------------------------------------------------------------
 */

import { AgentRegistryCard } from './AgentRegistryCard';
import type { AgentRecord } from '../../types/api';

// ---------------------------------------------------------------------------
// Sample agents used by all stories
// ---------------------------------------------------------------------------

const activeAgent: AgentRecord = {
  id: 'agent-research-001',
  name: 'Research Specialist',
  capabilities: ['research', 'report'],
  price: 0.5,
  reputation: 4.8,
  status: 'active',
  endpoint: 'https://agents.example.com/research',
  registrationTxHash: 'abc123def456789',
};

const codingAgent: AgentRecord = {
  id: 'agent-coding-002',
  name: 'Smart Contract Dev',
  capabilities: ['coding', 'audit'],
  price: 1.2,
  reputation: 4.9,
  status: 'active',
};

const inactiveAgent: AgentRecord = {
  id: 'agent-audit-003',
  name: 'QA Audit Agent',
  capabilities: ['coding', 'audit'],
  price: 0.8,
  reputation: 4.2,
  status: 'inactive',
};

const allCapabilitiesAgent: AgentRecord = {
  id: 'agent-full-004',
  name: 'Full-Stack Agent',
  capabilities: ['research', 'risk', 'coding', 'design', 'report'],
  price: 2.5,
  reputation: 5.0,
  status: 'active',
};

const noCapabilitiesAgent: AgentRecord = {
  id: 'agent-empty-005',
  name: 'Unconfigured Agent',
  capabilities: [],
  price: 0.1,
  reputation: 0,
  status: 'inactive',
};

// ---------------------------------------------------------------------------
// Story renders (plain React — replace with Meta/StoryObj once SB is added)
// ---------------------------------------------------------------------------

/**
 * Active agent with research + report capabilities.
 */
export function ActiveResearchAgent() {
  return (
    <div style={{ maxWidth: 320, padding: 24 }}>
      <AgentRegistryCard
        agent={activeAgent}
        onHire={(a) => alert(`Hiring: ${a.name}`)}
      />
    </div>
  );
}

/**
 * Active coding agent — green + orange badges.
 */
export function ActiveCodingAgent() {
  return (
    <div style={{ maxWidth: 320, padding: 24 }}>
      <AgentRegistryCard agent={codingAgent} />
    </div>
  );
}

/**
 * Inactive / offline agent — grey dot, hire CTA disabled.
 */
export function InactiveAgent() {
  return (
    <div style={{ maxWidth: 320, padding: 24 }}>
      <AgentRegistryCard agent={inactiveAgent} />
    </div>
  );
}

/**
 * Agent with all five capability colors at once.
 */
export function AllCapabilities() {
  return (
    <div style={{ maxWidth: 320, padding: 24 }}>
      <AgentRegistryCard agent={allCapabilitiesAgent} />
    </div>
  );
}

/**
 * Agent with no capabilities registered.
 */
export function NoCapabilities() {
  return (
    <div style={{ maxWidth: 320, padding: 24 }}>
      <AgentRegistryCard agent={noCapabilitiesAgent} />
    </div>
  );
}

/**
 * Dense grid showing multiple cards side-by-side (the typical page layout).
 */
export function DenseGrid() {
  const agents = [activeAgent, codingAgent, inactiveAgent, allCapabilitiesAgent];
  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))',
        gap: 16,
        padding: 24,
      }}
    >
      {agents.map((a) => (
        <AgentRegistryCard key={a.id} agent={a} />
      ))}
    </div>
  );
}

# Dispute Resolution Contract

The `dispute_resolution` Soroban contract holds task payment in the configured
asset while a task is eligible for dispute. Its admin registers each task's
submitter, agent, asset, amount, and completion timestamp using
`fund_task_escrow`; both the admin and submitter authorize the transfer.

The submitter may raise one dispute within 24 hours of the recorded completion
time. Five distinct arbiters are configured before the first dispute, and each
may cast one vote during the 72-hour voting window. Anyone may resolve after
the window: at least three Approve votes transfers the escrow to the agent;
otherwise it is returned to the submitter. A task without a dispute is paid to
the agent permissionlessly once its 24-hour dispute window ends.

`DisputeRaised`, `DisputeVoted`, and `DisputeResolved` events are emitted at
their respective lifecycle transitions. A task's escrow and dispute marker are
retained after settlement to prevent double settlement or reopening.

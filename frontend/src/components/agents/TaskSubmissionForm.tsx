/**
 * Backward-compatible alias for the task submission wizard.
 *
 * The implementation now lives in `components/tasks/TaskSubmissionWizard`;
 * this module keeps older imports (`components/agents/TaskSubmissionForm`)
 * working without duplicating the component.
 */
export {
  TaskSubmissionWizard,
  TaskSubmissionWizard as TaskSubmissionForm,
} from '../tasks/TaskSubmissionWizard';

export { TaskSubmissionWizard as default } from '../tasks/TaskSubmissionWizard';

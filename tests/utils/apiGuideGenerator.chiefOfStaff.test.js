/**
 * Tests for the Chief of Staff instruction generator.
 * These are pure-string assertions — no DB / fs needed.
 */

const {
  CHIEF_OF_STAFF_DEFAULT_NAME,
  generateChiefOfStaffInstructions,
  generateChiefOfStaffRosterSkill,
  generateChiefOfStaffTmuxSpawnSkill,
  generateMessageHelperPython
} = require('../../src/utils/apiGuideGenerator');

describe('Chief of Staff instruction generator', () => {

  it('exports a stable default name', () => {
    expect(CHIEF_OF_STAFF_DEFAULT_NAME).toBe('Local Chief of Staff');
  });

  describe('generateChiefOfStaffInstructions', () => {

    it('includes the role header, endpoints, and skill references', () => {
      const out = generateChiefOfStaffInstructions({
        userName: 'restin',
        apiBase: 'https://example.test/api'
      });

      expect(out).toContain(`Agent: ${CHIEF_OF_STAFF_DEFAULT_NAME}`);
      expect(out).toContain('You are the **Local Chief of Staff**');
      expect(out).toContain('the user (restin)');
      // Privileged endpoints
      expect(out).toContain('/agent/cos/spawn-child');
      expect(out).toContain('/agent/cos/roster');
      expect(out).toContain('/agent/cos/agents/<agent_id>/instructions');
      expect(out).toContain('/agent/cos/agents/<agent_id>');
      expect(out).toContain('/agent/cos/groups');
      expect(out).toContain('/agent/cos/groups/<group_id>/members');
      // A CoS has an explicit, idempotent recovery procedure for its own
      // locally-created agents.
      expect(out).toContain('Restart and recover a created agent');
      expect(out).toContain('tmux has-session');
      expect(out).toContain('systemctl --user restart agent-<folder>.service');
      // Skill file references
      expect(out).toContain('SKILL_AGENT_ROSTER.md');
      expect(out).toContain('SKILL_TMUX_SPAWN.md');
      expect(out).toContain('SKILL_RICH_FORMS.md');
      expect(out).toContain('SELF_WAKE_GUIDE.md');
      // Custom apiBase appears
      expect(out).toContain('https://example.test/api');
      // First-run UX is described
      expect(out).toContain('agent_state/installed_at.json');
      // Safety
      expect(out).toContain('Always confirm with the user before deletion');
    });

    it('falls back to a generic greeting when userName is missing', () => {
      const out = generateChiefOfStaffInstructions({});
      expect(out).toContain('the user');
      expect(out).not.toContain('the user ()');
    });

    it('appends both the base agent instructions and the orchestrator template', () => {
      const out = generateChiefOfStaffInstructions({});
      // generateAgentInstructions content marker — every base instructions block contains this header.
      expect(out).toContain('message_helper.py');
      // generateOrchestratorTemplate emits a marker — we just look for an unambiguous string.
      // The orchestrator template covers multi-agent coordination, so we look for "Orchestrator".
      expect(out.toLowerCase()).toContain('orchestrator');
    });
  });

  describe('generateChiefOfStaffRosterSkill', () => {
    it('documents the roster shape and refresh contract', () => {
      const out = generateChiefOfStaffRosterSkill();
      expect(out).toContain('Skill: Agent Roster');
      expect(out).toContain('/api/agent/cos/roster');
      expect(out).toContain('agent_state/roster.json');
      expect(out).toContain('rich_html');
    });
  });

  describe('generateChiefOfStaffTmuxSpawnSkill', () => {
    it('documents the four-step spawn playbook', () => {
      const out = generateChiefOfStaffTmuxSpawnSkill();
      expect(out).toContain('Skill: Local tmux spawn');
      expect(out).toContain('/agent/cos/spawn-child');
      expect(out).toContain('tmux new-session');
      expect(out).toContain('tmux kill-session');
      expect(out).toContain('confirmation');
    });

    it('documents per-task model choice on the mission DM', () => {
      const out = generateChiefOfStaffTmuxSpawnSkill();
      expect(out).toContain('--provider claude');
      expect(out).toContain('Omit the flags');
    });
  });

  describe('per-task model selection (CoS)', () => {
    it('documents the config endpoint and model-strength guidance in the CoS instructions', () => {
      const out = generateChiefOfStaffInstructions({
        apiBase: 'https://example.test/api'
      });
      expect(out).toContain("Choose an agent's provider/model per task");
      expect(out).toContain('https://example.test/api/agent/cos/agents/<agent_id>/config');
      expect(out).toContain('"model_provider": "claude"');
      // Strength-based guidance: strong model for hard work, cheap for routine
      expect(out).toMatch(/strong model/i);
      expect(out).toMatch(/fast\/cheap/i);
      // Backwards-compat promise: agents keep their model unless changed
      expect(out).toContain('keep their current model');
      // Helper commands
      expect(out).toContain('set-model');
      expect(out).toContain('--provider claude --model claude-fable-5');
    });

    it.each([true, false])('message_helper (encryption=%s) ships cos_set_agent_model, dm flags, and set-model', (enc) => {
      const py = generateMessageHelperPython(enc);
      expect(py).toContain('def cos_set_agent_model(');
      expect(py).toContain('/agent/cos/roster');
      expect(py).toContain('/agent/cos/agents/{match.get(\'agent_id\')}/config');
      // dm branch parses the new flags and applies the model before sending
      expect(py).toContain('dm_provider = rest[r + 1]');
      expect(py).toContain('dm_model = rest[r + 1]');
      expect(py).toContain('cfg_result = cos_set_agent_model(target, provider=dm_provider, model=dm_model)');
      // sending must still happen even if the model change fails (backwards compatible)
      expect(py).toContain('sending the DM anyway');
      // standalone command
      expect(py).toContain('elif command == "set-model":');
      // usage text updated
      expect(py).toContain('dm <agentName> <message> [--priority 0|1|2] [--provider <p>] [--model <m>]');
    });
  });
});

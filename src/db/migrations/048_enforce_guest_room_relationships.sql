-- Enforce guest scope in PostgreSQL as well as in the service validators.
CREATE UNIQUE INDEX IF NOT EXISTS agents_owner_pair ON agents(agent_id,user_id);
CREATE UNIQUE INDEX IF NOT EXISTS guest_shares_owner_pair ON guest_shares(share_id,owner_id);
CREATE UNIQUE INDEX IF NOT EXISTS shared_rooms_owner_agent_pair ON shared_conversations(id,agent_id,owner_id);

ALTER TABLE guest_share_agents ADD COLUMN IF NOT EXISTS owner_id UUID;
ALTER TABLE guest_share_rooms ADD COLUMN IF NOT EXISTS owner_id UUID;
UPDATE guest_share_agents a SET owner_id=s.owner_id FROM guest_shares s WHERE a.share_id=s.share_id AND a.owner_id IS NULL;
UPDATE guest_share_rooms r SET owner_id=s.owner_id FROM guest_shares s WHERE r.share_id=s.share_id AND r.owner_id IS NULL;
ALTER TABLE guest_share_agents ALTER COLUMN owner_id SET NOT NULL;
ALTER TABLE guest_share_rooms ALTER COLUMN owner_id SET NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS guest_share_agents_owner_pair ON guest_share_agents(share_id,agent_id,owner_id);

CREATE OR REPLACE FUNCTION assign_guest_mapping_owner() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.owner_id IS NULL THEN
    SELECT owner_id INTO NEW.owner_id FROM guest_shares WHERE share_id=NEW.share_id;
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS guest_agent_mapping_owner ON guest_share_agents;
CREATE TRIGGER guest_agent_mapping_owner BEFORE INSERT OR UPDATE ON guest_share_agents FOR EACH ROW EXECUTE FUNCTION assign_guest_mapping_owner();
DROP TRIGGER IF EXISTS guest_room_mapping_owner ON guest_share_rooms;
CREATE TRIGGER guest_room_mapping_owner BEFORE INSERT OR UPDATE ON guest_share_rooms FOR EACH ROW EXECUTE FUNCTION assign_guest_mapping_owner();

ALTER TABLE guest_share_agents DROP CONSTRAINT IF EXISTS guest_agents_share_owner;
ALTER TABLE guest_share_agents ADD CONSTRAINT guest_agents_share_owner FOREIGN KEY(share_id,owner_id) REFERENCES guest_shares(share_id,owner_id) ON DELETE CASCADE;
ALTER TABLE guest_share_agents DROP CONSTRAINT IF EXISTS guest_agents_agent_owner;
ALTER TABLE guest_share_agents ADD CONSTRAINT guest_agents_agent_owner FOREIGN KEY(agent_id,owner_id) REFERENCES agents(agent_id,user_id) ON DELETE CASCADE;
ALTER TABLE guest_share_agents DROP CONSTRAINT IF EXISTS guest_agents_room_owner;
ALTER TABLE guest_share_agents ADD CONSTRAINT guest_agents_room_owner FOREIGN KEY(room_id,agent_id,owner_id) REFERENCES shared_conversations(id,agent_id,owner_id) ON DELETE CASCADE;
ALTER TABLE guest_share_rooms DROP CONSTRAINT IF EXISTS guest_rooms_guest_share;
ALTER TABLE guest_share_rooms ADD CONSTRAINT guest_rooms_guest_share FOREIGN KEY(share_id,guest_id) REFERENCES guest_principals(share_id,guest_id) ON DELETE CASCADE;
ALTER TABLE guest_share_rooms DROP CONSTRAINT IF EXISTS guest_rooms_selected_agent;
ALTER TABLE guest_share_rooms ADD CONSTRAINT guest_rooms_selected_agent FOREIGN KEY(share_id,agent_id,owner_id) REFERENCES guest_share_agents(share_id,agent_id,owner_id) ON DELETE CASCADE;
ALTER TABLE guest_share_rooms DROP CONSTRAINT IF EXISTS guest_rooms_room_owner;
ALTER TABLE guest_share_rooms ADD CONSTRAINT guest_rooms_room_owner FOREIGN KEY(room_id,agent_id,owner_id) REFERENCES shared_conversations(id,agent_id,owner_id) ON DELETE CASCADE;

-- Common and separate modes have different mappings. Deferred checks permit
-- their transactional creation/deletion, but reject inconsistent committed rows.
CREATE OR REPLACE FUNCTION validate_guest_share_memberships(target_share UUID) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM shared_guest_members m WHERE m.share_id=target_share AND NOT EXISTS (
      SELECT 1 FROM guest_shares s
      JOIN guest_share_agents a ON a.share_id=s.share_id
      JOIN shared_conversations c ON c.id=m.conversation_id AND c.agent_id=a.agent_id AND c.owner_id=s.owner_id
      LEFT JOIN guest_share_rooms r ON r.share_id=s.share_id AND r.guest_id=m.guest_id AND r.agent_id=a.agent_id
      WHERE s.share_id=m.share_id AND (
        (s.room_mode='common' AND a.room_id=m.conversation_id) OR
        (s.room_mode='separate' AND r.room_id=m.conversation_id)
      )
    )
  ) THEN
    RAISE EXCEPTION 'Guest membership is outside its share conversation mapping' USING ERRCODE='23503';
  END IF;
END;
$$;
CREATE OR REPLACE FUNCTION check_guest_share_memberships() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP<>'DELETE' THEN PERFORM validate_guest_share_memberships(NEW.share_id); END IF;
  IF TG_OP<>'INSERT' THEN PERFORM validate_guest_share_memberships(OLD.share_id); END IF;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS guest_members_scope ON shared_guest_members;
CREATE CONSTRAINT TRIGGER guest_members_scope AFTER INSERT OR UPDATE OR DELETE ON shared_guest_members DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_guest_share_memberships();
DROP TRIGGER IF EXISTS guest_agents_members_scope ON guest_share_agents;
CREATE CONSTRAINT TRIGGER guest_agents_members_scope AFTER INSERT OR UPDATE OR DELETE ON guest_share_agents DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_guest_share_memberships();
DROP TRIGGER IF EXISTS guest_rooms_members_scope ON guest_share_rooms;
CREATE CONSTRAINT TRIGGER guest_rooms_members_scope AFTER INSERT OR UPDATE OR DELETE ON guest_share_rooms DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_guest_share_memberships();
DROP TRIGGER IF EXISTS guest_shares_members_scope ON guest_shares;
CREATE CONSTRAINT TRIGGER guest_shares_members_scope AFTER INSERT OR UPDATE OR DELETE ON guest_shares DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_guest_share_memberships();

DO $$
DECLARE current_share UUID;
BEGIN
  FOR current_share IN SELECT share_id FROM guest_shares LOOP
    PERFORM validate_guest_share_memberships(current_share);
  END LOOP;
END;
$$;

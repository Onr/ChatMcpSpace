-- Migration: 031_allow_multiple_chiefs_of_staff.sql
-- Description: Allow multiple named Local Chief of Staff agents per user.
-- Date: 2026-05-16

DROP INDEX IF EXISTS idx_agents_one_chief_of_staff_per_user;

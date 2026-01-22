-- Migration: Remove user_agent column from feedback table for privacy
-- PRIVACY FIX: The user_agent column enables browser fingerprinting when combined
-- with page_url and created_at, which contradicts the table's "true anonymity" promise.
--
-- This migration removes the column to ensure feedback remains truly anonymous.

-- Drop the user_agent column if it exists
ALTER TABLE feedback DROP COLUMN IF EXISTS user_agent;

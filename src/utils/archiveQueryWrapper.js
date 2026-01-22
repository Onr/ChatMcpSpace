/**
 * Archive Query Wrapper
 * Provides fallback behavior when archive tables don't exist
 * Ensures application works during schema migration
 */

const { logWarn } = require('./logger');

/**
 * Wraps queries that use archived tables to handle missing schema gracefully
 * @param {Function} queryFn - Async function that executes the query
 * @param {string} fallbackQuery - Query to run if archive tables don't exist
 * @param {Array} params - Query parameters
 * @param {string} context - Context for logging (e.g., 'get_agents')
 * @returns {Promise<Object>} Query result
 */
async function executeQueryWithArchiveFallback(queryFn, fallbackQuery, params, context = 'archive_query') {
  try {
    return await queryFn();
  } catch (error) {
    // Check if error is due to missing table
    if (error.code === '42P01') { // PostgreSQL "relation does not exist" error
      logWarn(`archive_query.fallback_triggered`, {
        context,
        table_missing: error.table,
        error_code: error.code
      });

      // Try fallback query if provided
      if (fallbackQuery) {
        try {
          const { query } = require('../db/connection');
          return await query(fallbackQuery, params);
        } catch (fallbackError) {
          logWarn(`archive_query.fallback_failed`, { context, error: fallbackError.message });
          throw error; // Throw original error if fallback also fails
        }
      }

      throw error;
    }

    // Re-throw non-archive-related errors
    throw error;
  }
}

/**
 * Checks if archive tables exist
 * @returns {Promise<boolean>}
 */
async function archiveTablesExist() {
  try {
    const { query } = require('../db/connection');
    const result = await query(`
      SELECT (
        SELECT COUNT(*) FROM information_schema.tables
        WHERE table_name IN ('archived_agents', 'archived_messages')
      ) = 2 as exists
    `);
    return result.rows[0].exists;
  } catch (error) {
    logWarn('archive_query.check_failed', { error: error.message });
    return false;
  }
}

/**
 * Wrap a query with archive table exclusion, falling back if tables don't exist
 * This is useful for queries that filter out archived content
 * @param {Function} archiveQuery - Function that returns full query with archive filtering
 * @param {Function} fallbackQuery - Function that returns query without archive filtering
 * @param {string} context - Context for logging
 * @returns {Function} Wrapped query function
 */
function createArchiveAwareQuery(archiveQuery, fallbackQuery, context = 'archive_aware') {
  return async (params) => {
    const { query } = require('../db/connection');

    try {
      const sql = archiveQuery();
      return await query(sql, params);
    } catch (error) {
      if (error.code === '42P01') {
        logWarn(`archive_aware_query.fallback`, { context });

        try {
          const fallbackSql = fallbackQuery();
          return await query(fallbackSql, params);
        } catch (fallbackError) {
          logWarn(`archive_aware_query.fallback_failed`, { context, error: fallbackError.message });
          throw error;
        }
      }

      throw error;
    }
  };
}

module.exports = {
  executeQueryWithArchiveFallback,
  archiveTablesExist,
  createArchiveAwareQuery
};

-- Files: starred, archived, last viewed
ALTER TABLE `files`
  ADD COLUMN `starred` BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN `starred_at` DATETIME(3) NULL,
  ADD COLUMN `archived_at` DATETIME(3) NULL,
  ADD COLUMN `last_viewed_at` DATETIME(3) NULL;

CREATE INDEX `files_user_id_starred_status_starred_at_idx` ON `files`(`user_id`, `starred`, `status`, `starred_at`);
CREATE INDEX `files_user_id_status_archived_at_idx` ON `files`(`user_id`, `status`, `archived_at`);
CREATE INDEX `files_user_id_status_last_viewed_at_idx` ON `files`(`user_id`, `status`, `last_viewed_at`);

-- File shares: replace plaintext token with reversible-encrypted token
ALTER TABLE `file_shares` ADD COLUMN `token_encrypted` TEXT NULL;

UPDATE `file_shares` SET `token_encrypted` = NULL;

DROP INDEX `file_shares_token_key` ON `file_shares`;

ALTER TABLE `file_shares` DROP COLUMN `token`;

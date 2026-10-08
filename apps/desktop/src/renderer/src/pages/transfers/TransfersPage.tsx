import { Button, EmptyState } from '@remote-desktop/ui';
import { ArrowLeftRight, FolderOpen } from 'lucide-react';
import { PageHeader } from '@/components/PageHeader';
import { getDesktopApi } from '@/lib/desktop-api';

/**
 * Files are transferred inside a live session (viewer toolbar on the
 * controlling side, "Send file" in the session indicator on the remote side)
 * and require the file-transfer permission. Received files are saved to
 * Downloads\Kestrel Remote, never overwriting anything.
 */
export function TransfersPage() {
  return (
    <>
      <PageHeader
        title="Transfers"
        description="Files sent to and received from remote devices."
        actions={
          <Button variant="outline" onClick={() => void getDesktopApi()?.files.openFolder()}>
            <FolderOpen aria-hidden="true" />
            Open received files
          </Button>
        }
      />
      <EmptyState
        icon={<ArrowLeftRight />}
        title="Transfer files during a session"
        description="Start a session with file transfer allowed, then use Send files in the viewer. Files you receive are saved to Downloads\Kestrel Remote and are verified (SHA-256) before they appear. A transfer history is not kept on this page yet."
      />
    </>
  );
}

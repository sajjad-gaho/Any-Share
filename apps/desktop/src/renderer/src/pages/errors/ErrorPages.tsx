import { Button, EmptyState } from '@remote-desktop/ui';
import { Compass, TriangleAlert } from 'lucide-react';
import { Link, isRouteErrorResponse, useRouteError } from 'react-router';

export function NotFoundPage() {
  return (
    <EmptyState
      icon={<Compass />}
      title="Page not found"
      description="The page you were looking for doesn't exist."
      action={
        <Button asChild variant="outline" size="sm">
          <Link to="/">Back to dashboard</Link>
        </Button>
      }
    />
  );
}

export function RouteErrorPage() {
  const error = useRouteError();
  const message = isRouteErrorResponse(error)
    ? `${error.status} ${error.statusText}`
    : error instanceof Error
      ? error.message
      : 'An unexpected error occurred.';

  return (
    <div className="flex h-full items-center justify-center p-8">
      <EmptyState
        role="alert"
        icon={<TriangleAlert />}
        title="Something went wrong"
        description={message}
        action={
          <Button asChild variant="outline" size="sm">
            <Link to="/">Back to dashboard</Link>
          </Button>
        }
        className="max-w-lg"
      />
    </div>
  );
}

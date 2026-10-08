import { UsersActionDialog } from './users-action-dialog'
import { UsersDeleteDialog } from './users-delete-dialog'
import { FreePointsDialog } from './free-points-dialog'
import { useUsers } from './users-provider'

export function UsersDialogs() {
  const {
    open,
    setOpen,
    currentRow,
    setCurrentRow,
    selectedClaimAccountId,
    setSelectedClaimAccountId,
  } = useUsers()
  return (
    <>
      <UsersActionDialog
        key='account-add'
        open={open === 'add'}
        onOpenChange={(isOpen) => setOpen(isOpen ? 'add' : null)}
      />

      <FreePointsDialog
        key='free-points'
        open={open === 'free-points'}
        onOpenChange={(isOpen) => {
          setOpen(isOpen ? 'free-points' : null)
          if (!isOpen) {
            setSelectedClaimAccountId(null)
          }
        }}
        defaultAccountId={selectedClaimAccountId}
      />

      {currentRow && (
        <>
          <UsersActionDialog
            key={`account-edit-${currentRow.id}`}
            open={open === 'edit'}
            onOpenChange={(isOpen) => {
              setOpen(isOpen ? 'edit' : null)
              if (!isOpen) {
                setTimeout(() => {
                  setCurrentRow(null)
                }, 300)
              }
            }}
            currentRow={currentRow}
          />

          <UsersDeleteDialog
            key={`account-delete-${currentRow.id}`}
            open={open === 'delete'}
            onOpenChange={(isOpen) => {
              setOpen(isOpen ? 'delete' : null)
              if (!isOpen) {
                setTimeout(() => {
                  setCurrentRow(null)
                }, 300)
              }
            }}
            currentRow={currentRow}
          />
        </>
      )}
    </>
  )
}

#!/usr/bin/env bash

set -Eeuo pipefail

readonly CLI_NAME="detro"
readonly SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
readonly PACKAGE_FILE="${SCRIPT_DIR}/package.json"
readonly PACKAGE_LOCK_FILE="${SCRIPT_DIR}/package-lock.json"
readonly INDEX_FILE="${SCRIPT_DIR}/index.js"
readonly COMPLETION_SOURCE="${SCRIPT_DIR}/detro-completion.bash"

readonly COMPLETION_DIR="${HOME}/.local/share/bash-completion/completions"
readonly COMPLETION_FILE="${COMPLETION_DIR}/${CLI_NAME}"
readonly BASHRC_FILE="${HOME}/.bashrc"

readonly BASHRC_MARKER_START="# >>> DETRO CLI >>>"
readonly BASHRC_MARKER_END="# <<< DETRO CLI <<<"

info() {
    printf '\033[1;36m%s\033[0m\n' "$1"
}

success() {
    printf '\033[1;32m%s\033[0m\n' "$1"
}

warning() {
    printf '\033[1;33m%s\033[0m\n' "$1"
}

error() {
    printf '\033[1;31mErro: %s\033[0m\n' "$1" >&2
}

die() {
    error "$1"
    exit 1
}

on_error() {
    local exit_code=$?
    local line_number="${1:-desconhecida}"

    error "A instalação falhou na linha ${line_number}."
    exit "${exit_code}"
}

trap 'on_error "$LINENO"' ERR

command_exists() {
    command -v "$1" >/dev/null 2>&1
}

validate_environment() {
    command_exists node || die "Node.js não está instalado."
    command_exists npm || die "npm não está instalado."

    [[ -f "${PACKAGE_FILE}" ]] ||
        die "Arquivo não encontrado: ${PACKAGE_FILE}"

    [[ -f "${INDEX_FILE}" ]] ||
        die "Arquivo não encontrado: ${INDEX_FILE}"

    [[ -f "${COMPLETION_SOURCE}" ]] ||
        die "Arquivo não encontrado: ${COMPLETION_SOURCE}"
}

ensure_permissions() {
    chmod +x "${INDEX_FILE}"
    chmod +x "${SCRIPT_DIR}/detro.sh"
}

install_dependencies() {
    info "Instalando dependências..."

    cd "${SCRIPT_DIR}"

    if [[ -f "${PACKAGE_LOCK_FILE}" ]]; then
        npm ci --no-audit --no-fund
    else
        npm install --no-audit --no-fund
    fi
}

install_cli() {
    info "Registrando comando ${CLI_NAME}..."
    cd "${SCRIPT_DIR}"
    npm link
}

install_completion() {
    info "Instalando autocomplete..."

    mkdir -p "${COMPLETION_DIR}"

    install \
        -m 0644 \
        "${COMPLETION_SOURCE}" \
        "${COMPLETION_FILE}"
}

remove_old_bashrc_configuration() {
    [[ -f "${BASHRC_FILE}" ]] || return 0

    local temporary_file
    temporary_file="$(mktemp)"

    awk \
        -v start="${BASHRC_MARKER_START}" \
        -v end="${BASHRC_MARKER_END}" \
        '
        $0 == start {
            removing = 1
            next
        }

        $0 == end {
            removing = 0
            next
        }

        !removing {
            print
        }
        ' "${BASHRC_FILE}" > "${temporary_file}"

    mv "${temporary_file}" "${BASHRC_FILE}"
}

configure_bashrc() {
    info "Configurando o Bash..."

    touch "${BASHRC_FILE}"

    remove_old_bashrc_configuration

    cat >> "${BASHRC_FILE}" <<EOF

${BASHRC_MARKER_START}
if [[ -f "${COMPLETION_FILE}" ]]; then
    source "${COMPLETION_FILE}"
fi
${BASHRC_MARKER_END}
EOF
}

verify_installation() {
    hash -r

    local installed_cli

    installed_cli="$(command -v "${CLI_NAME}" 2>/dev/null || true)"

    if [[ -z "${installed_cli}" ]]; then
        warning "A CLI foi instalada, mas o comando ainda não apareceu no PATH atual."
        warning "Abra um novo terminal para atualizar o ambiente."
        return 0
    fi

    success "CLI disponível em: ${installed_cli}"
}

uninstall_cli() {
    info "Removendo DETRO CLI..."

    cd "${SCRIPT_DIR}"

    npm unlink --global "${CLI_NAME}" >/dev/null 2>&1 ||
        npm unlink --global >/dev/null 2>&1 ||
        true

    rm -f "${COMPLETION_FILE}"

    remove_old_bashrc_configuration

    success "DETRO CLI removida."
    warning "Abra um novo terminal para concluir a atualização do ambiente."
}

show_help() {
    cat <<EOF
Uso:

  bash cli/detro.sh
  bash cli/detro.sh install
  bash cli/detro.sh update
  bash cli/detro.sh uninstall
  bash cli/detro.sh help

Comandos:

  install     Instala a CLI e o autocomplete
  update      Atualiza a instalação existente
  uninstall   Remove a CLI e o autocomplete
  help        Exibe esta ajuda

Sem argumentos, o comando executado será "install".
EOF
}

install_all() {
    validate_environment
    ensure_permissions
    install_dependencies
    install_cli
    install_completion
    configure_bashrc
    verify_installation

    echo
    success "DETRO CLI instalada com sucesso."
    echo
    printf 'Use:\n'
    printf '  %s\n' "${CLI_NAME}"
    printf '  %s restart\n' "${CLI_NAME}"
    printf '  %s logs\n' "${CLI_NAME}"
    echo
    warning "O autocomplete estará disponível automaticamente nos próximos terminais."
}

main() {
    local action="${1:-install}"

    case "${action}" in
        install|update)
            install_all
            ;;

        uninstall|remove)
            uninstall_cli
            ;;

        help|-h|--help)
            show_help
            ;;

        *)
            die "Comando desconhecido: ${action}. Use: bash cli/detro.sh help"
            ;;
    esac
}

main "$@"